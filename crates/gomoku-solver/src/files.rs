//! CLI-only filesystem boundary. Search and verification never read files.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn read(path: &str) -> Result<String, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > 128 * 1024 * 1024 {
        return Err("input exceeds 128 MiB".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn opening_records(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if path.is_file() {
        return read(path.to_str().ok_or("invalid UTF-8 input path")?);
    }
    let mut pending = vec![path.to_path_buf()];
    let mut selected = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                pending.push(entry.path());
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if kind.is_file()
                && (name.ends_with(".board2action.txt")
                    || matches!(
                        name.as_ref(),
                        "board2action_from_dir.txt" | "manually_added_step_str2move.txt"
                    ))
            {
                selected.push(entry.path());
            }
            if selected.len() + pending.len() > 100_000 {
                return Err("too many opening files".into());
            }
        }
    }
    selected.sort();
    if selected.is_empty() {
        return Err("no board-to-action files found".into());
    }
    let mut text = String::new();
    for file in selected {
        let content = read(file.to_str().ok_or("invalid UTF-8 opening path")?)?;
        if text.len() + content.len() + 1 > 128 * 1024 * 1024 {
            return Err("opening import exceeds 128 MiB; split the directory".into());
        }
        text.push_str(&content);
        text.push('\n');
    }
    Ok(text)
}

pub fn write_new(path: &str, text: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| e.to_string())
}

pub fn atomic_checkpoint(path: &str, text: &str) -> Result<(), String> {
    let temporary = format!("{path}.tmp-{}", std::process::id());
    write_new(&temporary, text)?;
    let result = fs::rename(&temporary, path).map_err(|e| e.to_string());
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

pub fn ensure_new(path: &str) -> Result<(), String> {
    if Path::new(path).symlink_metadata().is_ok() {
        return Err(format!("output already exists: {path}"));
    }
    Ok(())
}

pub fn distinct(paths: &[&str]) -> Result<(), String> {
    let resolved: Vec<_> = paths
        .iter()
        .map(|path| identity(path))
        .collect::<Result<_, _>>()?;
    for (i, path) in resolved.iter().enumerate() {
        if resolved[..i].contains(path) {
            return Err("input, output and checkpoint paths must be distinct".into());
        }
    }
    Ok(())
}

fn identity(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if path.exists() {
        return fs::canonicalize(path).map_err(|e| e.to_string());
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path.file_name().ok_or("path needs a filename")?;
    Ok(fs::canonicalize(parent)
        .map_err(|e| e.to_string())?
        .join(name))
}
