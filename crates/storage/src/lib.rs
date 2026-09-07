use std::fs::{OpenOptions, create_dir_all};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use contexttop_protocol::ContextEvent;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("storage I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("stored event is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn append_event(path: impl AsRef<Path>, event: &ContextEvent) -> Result<(), StorageError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, event)?;
    file.write_all(b"\n")?;
    Ok(())
}

pub fn read_events(path: impl AsRef<Path>) -> Result<Vec<ContextEvent>, StorageError> {
    let file = OpenOptions::new().read(true).open(path)?;
    BufReader::new(file)
        .lines()
        .map(|line| Ok(serde_json::from_str(&line?)?))
        .collect()
}
