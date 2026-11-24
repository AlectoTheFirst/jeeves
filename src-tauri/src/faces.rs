//! Face packages: list, read, install and remove .glb files in the faces folder.
//! The web view checks the full manifest when it loads a package. Here the shell only
//! checks what keeps the folder safe: the size, the GLB header and the package id.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{ipc::Response, AppHandle, Manager};

/// The same limit as MAX_PACKAGE_BYTES in web/scene/facePackage.ts.
const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const FORMAT: &str = "jeeves-face/1";

/// A package id: 1 to 40 lowercase letters, digits or "-", not "-" first.
pub(crate) fn is_package_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && bytes[0] != b'-'
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// The package id from the manifest in a GLB file.
pub(crate) fn package_id(data: &[u8]) -> Result<String, String> {
    if data.len() as u64 > MAX_PACKAGE_BYTES {
        return Err("the package is larger than 20 MB".into());
    }
    let u32_at = |at: usize| -> Option<u32> { data.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]])) };
    if u32_at(0) != Some(0x4654_6c67) {
        return Err("the file is not a GLB file".into());
    }
    if u32_at(4) != Some(2) {
        return Err("only glTF 2 is supported".into());
    }
    if u32_at(8).map(|n| n as usize) != Some(data.len()) {
        return Err("the GLB length does not agree with the file size".into());
    }
    let size = u32_at(12).ok_or("the GLB file has no JSON chunk")? as usize;
    if u32_at(16) != Some(0x4e4f_534a) || 20 + size > data.len() {
        return Err("the GLB file has no JSON chunk".into());
    }
    let json: serde_json::Value = serde_json::from_slice(&data[20..20 + size]).map_err(|e| format!("bad glTF JSON: {e}"))?;
    let manifest = &json["asset"]["extras"]["jeevesFace"];
    if manifest["format"].as_str() != Some(FORMAT) {
        return Err(format!("the file is not a Jeeves face package (format {FORMAT})"));
    }
    let id = manifest["id"].as_str().unwrap_or_default();
    if !is_package_id(id) {
        return Err("the package id must be 1 to 40 lowercase letters, digits or -".into());
    }
    Ok(id.to_string())
}

/// ~/Library/Application Support/app.jeeves.desktop/faces
fn faces_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("faces"))
}

fn package_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !is_package_id(id) {
        return Err(format!("bad package id {id:?}"));
    }
    Ok(faces_dir(app)?.join(format!("{id}.glb")))
}

/// The ids of the installed packages, sorted.
pub(crate) fn list_ids(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut ids: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".glb").map(str::to_string))
        .filter(|id| is_package_id(id))
        .collect();
    ids.sort();
    ids
}

#[tauri::command]
pub(crate) fn face_list(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(list_ids(&faces_dir(&app)?))
}

/// The bytes of 1 package, as an ArrayBuffer in the web view.
#[tauri::command]
pub(crate) fn face_read(app: AppHandle, id: String) -> Result<Response, String> {
    let path = package_path(&app, &id)?;
    let size = fs::metadata(&path).map_err(|e| format!("{id}: {e}"))?.len();
    if size > MAX_PACKAGE_BYTES {
        return Err(format!("{id}: the package is larger than 20 MB"));
    }
    Ok(Response::new(fs::read(&path).map_err(|e| format!("{id}: {e}"))?))
}

/// Copy a checked package into the faces folder. Returns its id.
pub(crate) fn install_file(dir: &Path, file: &Path) -> Result<String, String> {
    let size = fs::metadata(file).map_err(|e| e.to_string())?.len();
    if size > MAX_PACKAGE_BYTES {
        return Err("the package is larger than 20 MB".into());
    }
    let data = fs::read(file).map_err(|e| e.to_string())?;
    let id = package_id(&data)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Write to a temporary name first, so that a reader never gets half a file.
    let temp = dir.join(format!("{id}.glb.part"));
    fs::write(&temp, &data).map_err(|e| e.to_string())?;
    fs::rename(&temp, dir.join(format!("{id}.glb"))).map_err(|e| e.to_string())?;
    Ok(id)
}

/// Show a file chooser and install the chosen package. `None` if the user cancels.
#[tauri::command]
pub(crate) async fn face_install(app: AppHandle) -> Result<Option<String>, String> {
    let Some(file) = crate::run_chooser(
        &app,
        "return POSIX path of (choose file with prompt (item 1 of argv))",
        "Choose a Jeeves face package (.glb)",
    )
    .await?
    else {
        return Ok(None);
    };
    install_file(&faces_dir(&app)?, Path::new(&file)).map(Some)
}

#[tauri::command]
pub(crate) fn face_remove(app: AppHandle, id: String) -> Result<(), String> {
    fs::remove_file(package_path(&app, &id)?).map_err(|e| format!("{id}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glb(json: &str) -> Vec<u8> {
        let mut text = json.as_bytes().to_vec();
        while text.len() % 4 != 0 {
            text.push(b' ');
        }
        let total = 20 + text.len();
        let mut out = Vec::new();
        out.extend_from_slice(&0x4654_6c67u32.to_le_bytes());
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&(total as u32).to_le_bytes());
        out.extend_from_slice(&(text.len() as u32).to_le_bytes());
        out.extend_from_slice(&0x4e4f_534au32.to_le_bytes());
        out.extend_from_slice(&text);
        out
    }

    #[test]
    fn checks_package_ids() {
        assert!(is_package_id("totoro"));
        assert!(is_package_id("face-2"));
        assert!(!is_package_id(""));
        assert!(!is_package_id("-x"));
        assert!(!is_package_id("../evil"));
        assert!(!is_package_id("Big"));
        assert!(!is_package_id(&"a".repeat(41)));
    }

    #[test]
    fn reads_the_id_from_the_manifest() {
        let ok = glb(r#"{"asset":{"version":"2.0","extras":{"jeevesFace":{"format":"jeeves-face/1","id":"owl"}}}}"#);
        assert_eq!(package_id(&ok).unwrap(), "owl");
        let bad_id = glb(r#"{"asset":{"extras":{"jeevesFace":{"format":"jeeves-face/1","id":"../x"}}}}"#);
        assert!(package_id(&bad_id).is_err());
        let no_manifest = glb(r#"{"asset":{"version":"2.0"}}"#);
        assert!(package_id(&no_manifest).is_err());
        assert!(package_id(b"not a glb file at all").is_err());
    }

    #[test]
    fn installs_lists_and_replaces() {
        let root = std::env::temp_dir().join(format!("jeeves-faces-test-{}", std::process::id()));
        let dir = root.join("faces");
        fs::create_dir_all(&root).unwrap();
        let file = root.join("in.glb");
        fs::write(&file, glb(r#"{"asset":{"extras":{"jeevesFace":{"format":"jeeves-face/1","id":"owl"}}}}"#)).unwrap();
        assert_eq!(install_file(&dir, &file).unwrap(), "owl");
        assert_eq!(install_file(&dir, &file).unwrap(), "owl");
        fs::write(dir.join("Not-An-Id.glb"), b"x").unwrap();
        assert_eq!(list_ids(&dir), vec!["owl".to_string()]);
        fs::remove_dir_all(&root).unwrap();
    }
}
