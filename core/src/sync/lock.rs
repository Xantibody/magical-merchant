//! 同期のプロセス間排他。
//!
//! アプリ側の「同期中」フラグ (`AtomicBool`) はプロセス内でしか効かない。
//! 2 つの同期が同時に走ると `.sync-state.json` を後勝ちで上書きし合い、
//! `to_local_state` が「手元に無い」として落としたキーが相手の状態から消える。
//! 次の同期でそれは差分として蘇り、偽の競合コピーになる (`diff.rs`)。
//! 排他はプロセスをまたぐ必要があるので、ファイルシステムに置く。
//!
//! 今のところ同期を始めるのはアプリだけで、プロセスをまたぐ衝突は
//! 起きない。CLI から同期できるようにする (#170) とそうではなくなるので、
//! 先回りして 1 つに絞ってある。

use std::fs::{self, File, TryLockError};
use std::path::Path;

use super::SyncError;

/// `data/` の外に置く。中に置けばロックファイル自身が同期対象になる。
const LOCK_FILENAME: &str = ".sync.lock";

/// 生きているあいだだけ同期してよい。落とすと解放される。
///
/// ロックの実体は開いたファイル記述子に付く advisory lock なので、
/// プロセスが panic で落ちても kill されても OS が確実に外す。
/// 「前回の異常終了で残ったロックファイル」を人手で消す必要はない。
#[derive(Debug)]
pub struct SyncLock {
    file: File,
}

impl SyncLock {
    /// 取れなければ待たずに `busy` を返す。
    /// 同期は次の書き込みでも自動で走るので、順番待ちで固まるより見送るほうが安い。
    pub fn acquire(base_dir: &Path) -> Result<Self, SyncError> {
        // 初回起動直後はアプリのデータディレクトリ自体がまだ無いことがある
        fs::create_dir_all(base_dir).map_err(|e| {
            SyncError::other(format!(
                "Failed to prepare the sync lock directory ({}): {e}",
                base_dir.display()
            ))
        })?;

        let path = base_dir.join(LOCK_FILENAME);
        // truncate も削除もしない。意味を持つのはロックそのもので中身ではなく、
        // 消したり切り詰めたりすれば、ロックを持っていない側が持っている側の
        // ファイルに触ることになる
        let file = File::options()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| {
                SyncError::other(format!(
                    "Failed to open the sync lock ({}): {e}",
                    path.display()
                ))
            })?;

        match file.try_lock() {
            Ok(()) => Ok(Self { file }),
            Err(TryLockError::WouldBlock) => Err(SyncError::new(
                "busy",
                "Another sync is already running. Try again in a moment.",
            )),
            // ロックが取れたか分からないなら同期しない。
            // 排他できていないまま進むほうが高くつく
            Err(TryLockError::Error(e)) => Err(SyncError::other(format!(
                "Failed to lock {}: {e}",
                path.display()
            ))),
        }
    }
}

impl Drop for SyncLock {
    fn drop(&mut self) {
        // ファイルを閉じても外れるが、解放の責任がこの型にあることを明示しておく
        let _ = self.file.unlock();
    }
}

#[cfg(test)]
mod tests {
    use super::{LOCK_FILENAME, SyncLock};
    use std::path::Path;
    use std::process::Command;

    /// 子プロセスに「どのディレクトリを取りにいくか」を渡す。
    const CHILD_DIR_ENV: &str = "MM_SYNC_LOCK_TEST_DIR";
    /// 自分自身を起動し直すので、テスト名がそのまま子プロセスの入口になる。
    const CHILD_TEST: &str = "sync::lock::tests::a_second_process_cannot_take_a_held_lock";

    #[test]
    fn the_lock_file_lives_outside_the_synced_tree() {
        let dir = tempfile::tempdir().unwrap();
        let _lock = SyncLock::acquire(dir.path()).unwrap();

        assert!(dir.path().join(LOCK_FILENAME).exists());
        assert!(!dir.path().join("data").exists());
    }

    #[test]
    fn the_lock_is_released_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        {
            let _lock = SyncLock::acquire(dir.path()).unwrap();
        }

        assert!(SyncLock::acquire(dir.path()).is_ok());
    }

    /// スレッドを 2 つ回しても「プロセス間」を確かめたことにはならないので、
    /// テストバイナリ自身をもう 1 つ起動して、この同じテストを子として走らせる。
    #[test]
    fn a_second_process_cannot_take_a_held_lock() {
        // 子として起動された側。ロックを取りにいって結果を親に報告する
        if let Ok(dir) = std::env::var(CHILD_DIR_ENV) {
            match SyncLock::acquire(Path::new(&dir)) {
                Ok(_) => println!("child: acquired"),
                Err(e) => println!("child: {}", e.kind),
            }
            return;
        }

        let dir = tempfile::tempdir().unwrap();
        let _held = SyncLock::acquire(dir.path()).unwrap();

        let out = Command::new(std::env::current_exe().unwrap())
            .args([CHILD_TEST, "--exact", "--nocapture"])
            .env(CHILD_DIR_ENV, dir.path())
            .output()
            .unwrap();

        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("child: busy"),
            "the child process should have been refused; it said:\n{stdout}{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// 上のテストが「子を起動したつもりで何も走らせていなかった」に化けないよう、
    /// ロックが空いていれば子は取れることも確かめる。
    #[test]
    fn a_second_process_takes_a_free_lock() {
        let dir = tempfile::tempdir().unwrap();

        let out = Command::new(std::env::current_exe().unwrap())
            .args([CHILD_TEST, "--exact", "--nocapture"])
            .env(CHILD_DIR_ENV, dir.path())
            .output()
            .unwrap();

        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("child: acquired"),
            "the child process should have taken the free lock; it said:\n{stdout}{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}
