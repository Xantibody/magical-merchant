// Reproduce the audit against an isolated Git snapshot, using installed dependencies.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func main() {
	repoFlag := flag.String("repo", ".", "repository root")
	ref := flag.String("ref", "adb7d56bc29a33f68dfe865d19736712a02037ab", "Git revision to audit")
	prepare := flag.Bool("prepare-only", false, "prepare the snapshot without running tests")
	flag.Parse()
	repo, err := filepath.Abs(*repoFlag)
	must(err)
	assets := filepath.Join(repo, "docs/audits/2026-09-20")
	work, err := os.MkdirTemp("", "magical-audit-")
	must(err)
	fmt.Println("Isolated snapshot:", work)
	archive := exec.Command("git", "-C", repo, "archive", *ref)
	stream, err := archive.StdoutPipe()
	must(err)
	archive.Stderr = os.Stderr
	must(archive.Start())
	unpack := exec.Command("tar", "-x", "-C", work)
	unpack.Stdin, unpack.Stderr = stream, os.Stderr
	unpackErr := unpack.Run()
	archiveErr := archive.Wait()
	must(unpackErr)
	must(archiveErr)
	for _, surface := range []string{"workers", "tauri-app"} {
		must(os.Symlink(filepath.Join(repo, surface, "node_modules"), filepath.Join(work, surface, "node_modules")))
	}
	tests := map[string]string{
		"audit_tests.rs":         "core/src/sync/audit_tests.rs",
		"audit_concurrency.rs":   "core/tests/audit_concurrency.rs",
		"audit_paths.rs":         "core/tests/audit_paths.rs",
		"audit_scrawl_format.rs": "core/tests/audit_scrawl_format.rs",
		"audit_performance.rs":   "core/tests/audit_performance.rs",
		"worker.test.ts":         "workers/src/audit.test.ts",
		"session.test.ts":        "tauri-app/src/lib/audit.test.ts",
		"audit-sync.test.ts":     "tauri-app/src/lib/audit-sync.test.ts",
		"audit-editor.test.ts":   "tauri-app/src/lib/audit-editor.test.ts",
	}
	for source, target := range tests {
		data, err := os.ReadFile(filepath.Join(assets, "tests", source))
		must(err)
		path := filepath.Join(work, target)
		must(os.MkdirAll(filepath.Dir(path), 0755))
		must(os.WriteFile(path, data, 0644))
	}
	engine, err := os.OpenFile(filepath.Join(work, "core/src/sync/engine.rs"), os.O_APPEND|os.O_WRONLY, 0644)
	must(err)
	_, err = io.WriteString(engine, "\n#[cfg(test)]\n#[path = \"audit_tests.rs\"]\nmod audit_tests;\n")
	must(err)
	must(engine.Close())
	if *prepare {
		return
	}
	steps := []struct {
		name string
		dir  string
		args []string
	}{
		{"core", "", []string{"cargo", "test", "-p", "magical-merchant-core", "--features", "sync-client", "--no-fail-fast", "audit_", "--", "--nocapture"}},
		{"workers", "workers", []string{"node", "node_modules/vitest/vitest.mjs", "run", "src/audit.test.ts"}},
		{"frontend", "tauri-app", []string{"node", "node_modules/vitest/vitest.mjs", "run", "src/lib/audit.test.ts", "src/lib/audit-sync.test.ts", "src/lib/audit-editor.test.ts"}},
	}
	failed := false
	for _, step := range steps {
		logPath := filepath.Join(work, step.name+".log")
		log, err := os.Create(logPath)
		must(err)
		cmd := exec.Command(step.args[0], step.args[1:]...)
		cmd.Dir = filepath.Join(work, step.dir)
		cmd.Env = append(os.Environ(), "CARGO_TARGET_DIR="+filepath.Join(repo, "target"))
		cmd.Stdout, cmd.Stderr = log, log
		err = cmd.Run()
		must(log.Close())
		fmt.Printf("%s: %v (log: %s)\n", step.name, err, logPath)
		failed = failed || err != nil
	}
	if failed {
		fmt.Println("Failures are expected on the audited revision; inspect the assertion failures in the logs.")
		os.Exit(1)
	}
}
