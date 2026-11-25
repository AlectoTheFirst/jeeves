//! Face packages: list, read, install and remove .glb files in the faces folder.
//! The web view checks the full manifest when it loads a package. Here the shell only
//! checks what keeps the folder safe: the size, the GLB header and the package id.
//! `installed.json` in the faces folder records the source and the hash of each package.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{ipc::Response, AppHandle, Manager, State};

use crate::catalog::{self, Catalog};

/// The same limit as MAX_PACKAGE_BYTES in web/scene/facePackage.ts.
pub(crate) const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const FORMAT: &str = "jeeves-face/1";
const RECORD_FILE: &str = "installed.json";

/// Serializes the read, change and write of the record file.
static RECORD_LOCK: Mutex<()> = Mutex::new(());

/// A package id: 1 to 40 lowercase letters, digits or "-", not "-" first.
pub(crate) fn is_package_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 40
        && bytes[0] != b'-'
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// The manifest fields that the shell keeps.
#[derive(Debug, PartialEq)]
pub(crate) struct Meta {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
}

/// The manifest fields of a GLB file.
pub(crate) fn package_meta(data: &[u8]) -> Result<Meta, String> {
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
    let text = |key: &str| manifest[key].as_str().unwrap_or_default().chars().take(100).collect::<String>();
    Ok(Meta { id: id.to_string(), name: text("name"), version: text("version"), author: text("author") })
}

/// Where a package came from: "file", "url" or "catalog".
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub source: String,
    /// The file path or the download URL.
    pub origin: String,
    /// The catalog URL for source "catalog", else empty.
    #[serde(default)]
    pub catalog: String,
    pub sha256: String,
    /// Unix seconds.
    pub installed: u64,
    pub name: String,
    pub version: String,
    pub author: String,
}

/// 1 installed package and its record. A package from before the record file has no record.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Installed {
    pub id: String,
    pub record: Option<Record>,
}

/// The result of an install. `confirm`: a package with the same id from another author or of
/// unknown origin is there, and `face_confirm` decides.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Outcome {
    Installed { id: String, record: Record },
    Unchanged { id: String },
    Confirm { id: String, old: Option<Record>, new: Record },
}

/// A package that waits for `face_confirm`.
pub(crate) struct Pending {
    data: Vec<u8>,
    record: Record,
    id: String,
    /// The hash of the installed package when the question was asked.
    old_sha: Option<String>,
}

pub(crate) struct Staged(pub Mutex<Option<Pending>>);

/// The records. A file that does not parse is moved to `installed.json.bad`, so that the next
/// write does not lose it.
fn read_records(dir: &Path) -> BTreeMap<String, Record> {
    let path = dir.join(RECORD_FILE);
    let Ok(data) = fs::read(&path) else { return BTreeMap::new() };
    serde_json::from_slice(&data).unwrap_or_else(|err| {
        eprintln!("[faces] {RECORD_FILE} is damaged ({err}), moved to {RECORD_FILE}.bad");
        let _ = fs::rename(&path, dir.join(format!("{RECORD_FILE}.bad")));
        BTreeMap::new()
    })
}

fn write_records(dir: &Path, records: &BTreeMap<String, Record>) -> Result<(), String> {
    let temp = dir.join(format!("{RECORD_FILE}.part"));
    fs::write(&temp, serde_json::to_vec_pretty(records).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&temp, dir.join(RECORD_FILE)).map_err(|e| e.to_string())
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The record for new package bytes. `catalog` is empty unless the source is "catalog".
pub(crate) fn new_record(data: &[u8], source: &str, origin: &str, catalog: &str) -> Result<(String, Record), String> {
    let meta = package_meta(data)?;
    let record = Record {
        source: source.into(),
        origin: origin.chars().take(2000).collect(),
        catalog: catalog.into(),
        sha256: catalog::sha256_hex(data),
        installed: now(),
        name: meta.name,
        version: meta.version,
        author: meta.author,
    };
    Ok((meta.id, record))
}

/// The hash of the installed package: from its record, else from the file. None if there is no package.
fn installed_sha(dir: &Path, id: &str, records: &BTreeMap<String, Record>) -> Option<String> {
    let path = dir.join(format!("{id}.glb"));
    if !path.is_file() {
        return None;
    }
    match records.get(id) {
        Some(record) => Some(record.sha256.clone()),
        None => fs::read(&path).ok().map(|d| catalog::sha256_hex(&d)),
    }
}

/// Install checked package bytes. Jeeves asks first when the installed package with the same id
/// has other bytes and also another author, another source or catalog, or no record.
/// `replace` is the hash of the installed package that the user agreed to replace. The install
/// goes ahead without a question only while that hash is still the installed one.
/// Also returns the hash of the package that was installed before.
pub(crate) fn install_bytes(
    dir: &Path,
    data: &[u8],
    id: &str,
    record: Record,
    replace: Option<&Option<String>>,
) -> Result<(Outcome, Option<String>), String> {
    let _lock = RECORD_LOCK.lock().map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut records = read_records(dir);
    let old = records.get(id).cloned();
    let current = installed_sha(dir, id, &records);
    let agreed = replace.is_some_and(|sha| *sha == current);
    if current.is_some() && !agreed {
        let same_bytes = current.as_deref() == Some(record.sha256.as_str());
        if same_bytes && old.is_some() {
            return Ok((Outcome::Unchanged { id: id.into() }, current));
        }
        let same_origin = old.as_ref().is_some_and(|old| {
            old.author == record.author && old.source == record.source && old.catalog == record.catalog
        });
        if !same_bytes && !same_origin {
            return Ok((Outcome::Confirm { id: id.into(), old, new: record }, current));
        }
    }
    // Write to a temporary name first, so that a reader never gets half a file.
    let temp = dir.join(format!("{id}.glb.part"));
    fs::write(&temp, data).map_err(|e| e.to_string())?;
    fs::rename(&temp, dir.join(format!("{id}.glb"))).map_err(|e| e.to_string())?;
    records.insert(id.into(), record.clone());
    write_records(dir, &records)?;
    Ok((Outcome::Installed { id: id.into(), record }, current))
}

/// Read and check a package file. Returns the bytes, the id and the record.
pub(crate) fn read_package_file(file: &Path) -> Result<(Vec<u8>, String, Record), String> {
    let size = fs::metadata(file).map_err(|e| e.to_string())?.len();
    if size > MAX_PACKAGE_BYTES {
        return Err("the package is larger than 20 MB".into());
    }
    let data = fs::read(file).map_err(|e| e.to_string())?;
    let (id, record) = new_record(&data, "file", &file.to_string_lossy(), "")?;
    Ok((data, id, record))
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

/// The installed packages with their records, sorted by id.
pub(crate) fn list_installed(dir: &Path) -> Result<Vec<Installed>, String> {
    let _lock = RECORD_LOCK.lock().map_err(|e| e.to_string())?;
    let records = read_records(dir);
    Ok(list_ids(dir).into_iter().map(|id| Installed { record: records.get(&id).cloned(), id }).collect())
}

/// Run blocking work off the main thread and the async runtime threads.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn face_list(app: AppHandle) -> Result<Vec<Installed>, String> {
    let dir = faces_dir(&app)?;
    blocking(move || list_installed(&dir)).await
}

/// The bytes of 1 package, as an ArrayBuffer in the web view.
#[tauri::command]
pub(crate) async fn face_read(app: AppHandle, id: String) -> Result<Response, String> {
    let path = package_path(&app, &id)?;
    blocking(move || {
        let size = fs::metadata(&path).map_err(|e| format!("{id}: {e}"))?.len();
        if size > MAX_PACKAGE_BYTES {
            return Err(format!("{id}: the package is larger than 20 MB"));
        }
        Ok(Response::new(fs::read(&path).map_err(|e| format!("{id}: {e}"))?))
    })
    .await
}

/// Show a file chooser and install the chosen package. `None` if the user cancels.
#[tauri::command]
pub(crate) async fn face_install(app: AppHandle, staged: State<'_, Staged>) -> Result<Option<Outcome>, String> {
    clear_staged(&staged);
    let Some(file) = crate::run_chooser(
        &app,
        "return POSIX path of (choose file with prompt (item 1 of argv))",
        "Choose a Jeeves face package (.glb)",
    )
    .await?
    else {
        return Ok(None);
    };
    let dir = faces_dir(&app)?;
    let (data, id, record) = blocking(move || read_package_file(Path::new(&file))).await?;
    blocking_install(&staged, dir, data, id, record).await.map(Some)
}

fn clear_staged(staged: &Staged) {
    if let Ok(mut slot) = staged.0.lock() {
        *slot = None;
    }
}

/// `install_and_stage` off the async runtime threads. The staged slot is set after the install.
async fn blocking_install(staged: &Staged, dir: PathBuf, data: Vec<u8>, id: String, record: Record) -> Result<Outcome, String> {
    let (outcome, old_sha, data) = blocking(move || {
        let (outcome, old_sha) = install_bytes(&dir, &data, &id, record, None)?;
        Ok((outcome, old_sha, data))
    })
    .await?;
    let mut slot = staged.0.lock().map_err(|e| e.to_string())?;
    *slot = match &outcome {
        Outcome::Confirm { id, new, .. } => Some(Pending { data, record: new.clone(), id: id.clone(), old_sha }),
        _ => None,
    };
    Ok(outcome)
}

/// Download and install a package. A non-empty `sha256` must match the file.
#[tauri::command]
pub(crate) async fn face_install_url(
    app: AppHandle,
    staged: State<'_, Staged>,
    url: String,
    sha256: String,
) -> Result<Outcome, String> {
    clear_staged(&staged);
    let expected = sha256.trim().to_ascii_lowercase();
    if !expected.is_empty() && !catalog::is_sha256(&expected) {
        return Err("the SHA-256 must be 64 hex characters".into());
    }
    let dir = faces_dir(&app)?;
    let (data, id, record) = blocking(move || {
        let data = catalog::fetch(url.trim(), MAX_PACKAGE_BYTES)?;
        let (id, record) = new_record(&data, "url", url.trim(), "")?;
        if !expected.is_empty() && record.sha256 != expected {
            return Err(format!("the SHA-256 of the download is {}, not {expected}", record.sha256));
        }
        Ok((data, id, record))
    })
    .await?;
    blocking_install(&staged, dir, data, id, record).await
}

/// Load a catalog. A non-empty `key` makes a valid signature necessary.
#[tauri::command]
pub(crate) async fn face_catalog(url: String, key: String) -> Result<Catalog, String> {
    blocking(move || catalog::load_catalog(url.trim(), &key)).await
}

/// Install 1 face of a catalog. The shell loads and checks the catalog again, so the web view
/// cannot give a different URL or hash.
#[tauri::command]
pub(crate) async fn face_install_catalog(
    app: AppHandle,
    staged: State<'_, Staged>,
    url: String,
    key: String,
    id: String,
) -> Result<Outcome, String> {
    clear_staged(&staged);
    let dir = faces_dir(&app)?;
    let (data, package, record) = blocking(move || {
        let catalog = catalog::load_catalog(url.trim(), &key)?;
        let entry = catalog.faces.iter().find(|f| f.id == id).ok_or(format!("the catalog has no face {id}"))?;
        let data = catalog::fetch(&entry.url, entry.size)?;
        let (package, record) = new_record(&data, "catalog", &entry.url, &catalog.url)?;
        if record.sha256 != entry.sha256 {
            return Err(format!("{id}: the download does not match the hash in the catalog"));
        }
        if package != entry.id {
            return Err(format!("{id}: the package has the id {package}"));
        }
        Ok((data, package, record))
    })
    .await?;
    blocking_install(&staged, dir, data, package, record).await
}

/// Answer the question of the last install. `id` and `sha256` name the package in the question;
/// a different staged package is refused. If the installed package changed after the question,
/// the outcome is a new question. `None` if nothing waits or the user said no.
#[tauri::command]
pub(crate) async fn face_confirm(
    app: AppHandle,
    staged: State<'_, Staged>,
    accept: bool,
    id: String,
    sha256: String,
) -> Result<Option<Outcome>, String> {
    let Some(Pending { data, record, id: staged_id, old_sha }) = staged.0.lock().map_err(|e| e.to_string())?.take() else {
        return Ok(None);
    };
    if !accept {
        return Ok(None);
    }
    if staged_id != id || record.sha256 != sha256 {
        return Err("the package to replace is no longer the one in the question".into());
    }
    let dir = faces_dir(&app)?;
    let (outcome, current, data) = blocking(move || {
        let (outcome, current) = install_bytes(&dir, &data, &staged_id, record, Some(&old_sha))?;
        Ok((outcome, current, data))
    })
    .await?;
    if let Outcome::Confirm { id, new, .. } = &outcome {
        *staged.0.lock().map_err(|e| e.to_string())? =
            Some(Pending { data, record: new.clone(), id: id.clone(), old_sha: current });
    }
    Ok(Some(outcome))
}

#[tauri::command]
pub(crate) async fn face_remove(app: AppHandle, id: String) -> Result<(), String> {
    let path = package_path(&app, &id)?;
    let dir = faces_dir(&app)?;
    blocking(move || {
        let _lock = RECORD_LOCK.lock().map_err(|e| e.to_string())?;
        fs::remove_file(path).map_err(|e| format!("{id}: {e}"))?;
        let mut records = read_records(&dir);
        if records.remove(&id).is_some() {
            write_records(&dir, &records)?;
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glb(json: &str) -> Vec<u8> {
        let mut text = json.as_bytes().to_vec();
        while !text.len().is_multiple_of(4) {
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
        assert_eq!(package_meta(&ok).unwrap().id, "owl");
        let bad_id = glb(r#"{"asset":{"extras":{"jeevesFace":{"format":"jeeves-face/1","id":"../x"}}}}"#);
        assert!(package_meta(&bad_id).is_err());
        let no_manifest = glb(r#"{"asset":{"version":"2.0"}}"#);
        assert!(package_meta(&no_manifest).is_err());
        assert!(package_meta(b"not a glb file at all").is_err());
    }

    fn package(id: &str, author: &str, extra: &str) -> Vec<u8> {
        glb(&format!(
            r#"{{"asset":{{"extras":{{"jeevesFace":{{"format":"jeeves-face/1","id":"{id}","name":"Owl","version":"1","author":"{author}","x":"{extra}"}}}}}}}}"#
        ))
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("jeeves-faces-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn install_file(dir: &Path, file: &Path, replace: Option<&Option<String>>) -> Result<Outcome, String> {
        let (data, id, record) = read_package_file(file)?;
        install_bytes(dir, &data, &id, record, replace).map(|(outcome, _)| outcome)
    }

    fn kind(outcome: &Outcome) -> &'static str {
        match outcome {
            Outcome::Installed { .. } => "installed",
            Outcome::Unchanged { .. } => "unchanged",
            Outcome::Confirm { .. } => "confirm",
        }
    }

    #[test]
    fn reads_the_manifest_fields() {
        let meta = package_meta(&package("owl", "Ann", "")).unwrap();
        assert_eq!(meta, Meta { id: "owl".into(), name: "Owl".into(), version: "1".into(), author: "Ann".into() });
    }

    #[test]
    fn installs_lists_and_records() {
        let root = temp_root("list");
        let dir = root.join("faces");
        let file = root.join("in.glb");
        fs::write(&file, package("owl", "Ann", "")).unwrap();
        assert_eq!(kind(&install_file(&dir, &file, None).unwrap()), "installed");
        assert_eq!(kind(&install_file(&dir, &file, None).unwrap()), "unchanged");
        fs::write(dir.join("Not-An-Id.glb"), b"x").unwrap();
        let list = list_installed(&dir).unwrap();
        assert_eq!(list.len(), 1);
        let record = list[0].record.clone().unwrap();
        assert_eq!((record.source.as_str(), record.author.as_str()), ("file", "Ann"));
        assert_eq!(record.sha256, catalog::sha256_hex(&package("owl", "Ann", "")));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn asks_before_another_author_replaces_a_package() {
        let root = temp_root("replace");
        let dir = root.join("faces");
        let file = root.join("in.glb");
        fs::write(&file, package("owl", "Ann", "")).unwrap();
        install_file(&dir, &file, None).unwrap();
        // The same author with new bytes is an update.
        fs::write(&file, package("owl", "Ann", "v2")).unwrap();
        assert_eq!(kind(&install_file(&dir, &file, None).unwrap()), "installed");
        // Another author needs a confirmation, and nothing changes before it.
        fs::write(&file, package("owl", "Bob", "")).unwrap();
        let outcome = install_file(&dir, &file, None).unwrap();
        assert_eq!(kind(&outcome), "confirm");
        assert_eq!(read_records(&dir)["owl"].author, "Ann");
        // A yes for another installed package asks again.
        let stale = Some(catalog::sha256_hex(&package("owl", "Ann", "")));
        assert_eq!(kind(&install_file(&dir, &file, Some(&stale)).unwrap()), "confirm");
        let agreed = Some(catalog::sha256_hex(&package("owl", "Ann", "v2")));
        assert_eq!(kind(&install_file(&dir, &file, Some(&agreed)).unwrap()), "installed");
        assert_eq!(read_records(&dir)["owl"].author, "Bob");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn asks_before_a_package_from_another_source_replaces_it() {
        let root = temp_root("source");
        let dir = root.join("faces");
        let data = package("owl", "Ann", "");
        let (id, mut record) = new_record(&data, "catalog", "https://a.org/owl.glb", "https://a.org/index.json").unwrap();
        install_bytes(&dir, &data, &id, record.clone(), None).unwrap();
        let v2 = package("owl", "Ann", "v2");
        let (_, url_record) = new_record(&v2, "url", "https://b.org/owl.glb", "").unwrap();
        assert_eq!(kind(&install_bytes(&dir, &v2, &id, url_record, None).unwrap().0), "confirm");
        record.sha256 = catalog::sha256_hex(&v2);
        assert_eq!(kind(&install_bytes(&dir, &v2, &id, record, None).unwrap().0), "installed");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn keeps_a_damaged_record_file() {
        let root = temp_root("damaged");
        let dir = root.join("faces");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(RECORD_FILE), b"{ not json").unwrap();
        assert!(read_records(&dir).is_empty());
        assert_eq!(fs::read(dir.join(format!("{RECORD_FILE}.bad"))).unwrap(), b"{ not json");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn asks_before_a_package_without_a_record_is_replaced() {
        let root = temp_root("legacy");
        let dir = root.join("faces");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("owl.glb"), package("owl", "Ann", "")).unwrap();
        let file = root.join("in.glb");
        // The same bytes only add the record.
        fs::write(&file, package("owl", "Ann", "")).unwrap();
        assert_eq!(kind(&install_file(&dir, &file, None).unwrap()), "installed");
        fs::remove_file(dir.join(RECORD_FILE)).unwrap();
        fs::write(&file, package("owl", "Ann", "v2")).unwrap();
        assert_eq!(kind(&install_file(&dir, &file, None).unwrap()), "confirm");
        fs::remove_dir_all(&root).unwrap();
    }
}
