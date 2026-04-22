use std::future::Future;

use chrono::{DateTime, Utc};

use crate::CoreError;

#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub key: String,
    pub last_modified: DateTime<Utc>,
    pub size: u64,
}

pub trait SyncClient: Send + Sync {
    fn list_remote(
        &self,
    ) -> impl Future<Output = Result<Vec<RemoteFile>, CoreError>> + Send;

    fn download(&self, key: &str) -> impl Future<Output = Result<Vec<u8>, CoreError>> + Send;

    fn upload(
        &self,
        key: &str,
        content: &[u8],
        last_modified: DateTime<Utc>,
    ) -> impl Future<Output = Result<(), CoreError>> + Send;

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), CoreError>> + Send;
}
