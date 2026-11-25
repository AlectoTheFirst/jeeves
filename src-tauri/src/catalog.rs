//! Downloads of face packages and face catalogs over HTTPS, and the check of a catalog signature.
//! The catalog format is in docs/face-packages.md.

use std::collections::HashSet;
use std::time::Duration;

use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::faces::{is_package_id, MAX_PACKAGE_BYTES};

const CATALOG_FORMAT: &str = "jeeves-face-catalog/1";
const MAX_INDEX_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 1024;
const MAX_ENTRIES: usize = 500;

/// 1 face in a catalog. `url` is absolute after `parse_catalog`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub license: String,
    #[serde(default)]
    pub description: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct CatalogFile {
    format: String,
    faces: Vec<CatalogEntry>,
}

/// A loaded catalog. `signed` is true when the index matched the catalog key.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalog {
    pub url: String,
    pub signed: bool,
    pub faces: Vec<CatalogEntry>,
}

/// Lowercase hex of bytes.
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Bytes from hex text. Upper and lower case are accepted.
pub(crate) fn unhex(text: &str) -> Option<Vec<u8>> {
    let text = text.trim();
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok()).collect()
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// True for 64 hex characters.
pub(crate) fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

fn check_https(url: &str) -> Result<(), String> {
    if !url.starts_with("https://") || url.len() > 2000 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("not an HTTPS URL: {url}"));
    }
    Ok(())
}

/// GET an HTTPS URL. Redirects must also be HTTPS. Fails when the body is larger than `limit` bytes.
pub(crate) fn fetch(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    check_https(url)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(5)
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .into();
    let mut response = agent.get(url).call().map_err(|e| format!("{url}: {e}"))?;
    response.body_mut().with_config().limit(limit).read_to_vec().map_err(|e| match e {
        ureq::Error::BodyExceedsLimit(_) => format!("{url}: the file is larger than {limit} bytes"),
        e => format!("{url}: {e}"),
    })
}

/// A URL split before its query or fragment.
fn split_query(url: &str) -> (&str, &str) {
    url.split_at(url.find(['?', '#']).unwrap_or(url.len()))
}

/// The URL of the signature file: ".sig" after the path, before the query.
fn signature_url(url: &str) -> String {
    let (path, query) = split_query(url);
    format!("{path}.sig{query}")
}

/// The absolute URL of a catalog entry. A relative URL is a file name next to the index.
fn resolve(catalog_url: &str, url: &str) -> Result<String, String> {
    if url.starts_with("https://") {
        check_https(url)?;
        return Ok(url.to_string());
    }
    let plain = !url.is_empty()
        && !url.contains("://")
        && !url.starts_with('/')
        && !url.contains('\\')
        && !url.contains('?')
        && !url.contains('#')
        && url.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
    if !plain {
        return Err(format!("bad package URL in the catalog: {url}"));
    }
    let (path, _) = split_query(catalog_url);
    let rest = path.strip_prefix("https://").ok_or("bad catalog URL")?;
    if !rest.contains('/') {
        return Err(format!("the catalog URL needs a path after the host: {catalog_url}"));
    }
    Ok(format!("https://{}{url}", &rest[..=rest.rfind('/').unwrap_or(0)]))
}

/// Check an index and make its package URLs absolute.
pub(crate) fn parse_catalog(catalog_url: &str, index: &[u8]) -> Result<Vec<CatalogEntry>, String> {
    let file: CatalogFile = serde_json::from_slice(index).map_err(|e| format!("bad catalog index: {e}"))?;
    if file.format != CATALOG_FORMAT {
        return Err(format!("the catalog format must be {CATALOG_FORMAT}"));
    }
    if file.faces.len() > MAX_ENTRIES {
        return Err(format!("the catalog has more than {MAX_ENTRIES} faces"));
    }
    let mut ids = HashSet::new();
    let mut faces = Vec::with_capacity(file.faces.len());
    for mut entry in file.faces {
        if !is_package_id(&entry.id) || !ids.insert(entry.id.clone()) {
            return Err(format!("bad or repeated face id in the catalog: {:?}", entry.id));
        }
        if !is_sha256(&entry.sha256) {
            return Err(format!("{}: the sha256 must be 64 hex characters", entry.id));
        }
        if entry.size == 0 || entry.size > MAX_PACKAGE_BYTES {
            return Err(format!("{}: the size must be 1 byte to 20 MB", entry.id));
        }
        entry.sha256 = entry.sha256.to_ascii_lowercase();
        entry.url = resolve(catalog_url, &entry.url)?;
        for text in [&mut entry.name, &mut entry.version, &mut entry.author, &mut entry.license] {
            *text = text.chars().take(100).collect();
        }
        entry.description = entry.description.chars().take(1000).collect();
        faces.push(entry);
    }
    Ok(faces)
}

/// Check an ed25519 signature of the index. The key is 32 bytes and the signature 64 bytes, both as hex.
pub(crate) fn verify_index(index: &[u8], key_hex: &str, signature_hex: &str) -> Result<(), String> {
    let key: [u8; 32] = unhex(key_hex)
        .and_then(|b| b.try_into().ok())
        .ok_or("the catalog key must be 64 hex characters")?;
    let signature: [u8; 64] = unhex(signature_hex)
        .and_then(|b| b.try_into().ok())
        .ok_or("the catalog signature must be 128 hex characters")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "the catalog key is not a valid ed25519 key")?;
    key.verify_strict(index, &Signature::from_bytes(&signature))
        .map_err(|_| "the catalog signature does not match the catalog key".to_string())
}

/// Download and check a catalog. With a key, the index must have a valid signature in `<url>.sig`.
pub(crate) fn load_catalog(url: &str, key_hex: &str) -> Result<Catalog, String> {
    let index = fetch(url, MAX_INDEX_BYTES)?;
    let signed = !key_hex.trim().is_empty();
    if signed {
        let signature = fetch(&signature_url(url), MAX_SIGNATURE_BYTES)?;
        verify_index(&index, key_hex, &String::from_utf8_lossy(&signature))?;
    }
    Ok(Catalog { url: url.to_string(), signed, faces: parse_catalog(url, &index)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_hex() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
        assert_eq!(unhex("000FfF"), Some(vec![0, 15, 255]));
        assert_eq!(unhex("abc"), None);
        assert_eq!(unhex("zz"), None);
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn resolves_package_urls() {
        let base = "https://example.org/faces/index.json?x=1";
        assert_eq!(resolve(base, "owl.glb").unwrap(), "https://example.org/faces/owl.glb");
        assert_eq!(resolve(base, "v2/owl.glb").unwrap(), "https://example.org/faces/v2/owl.glb");
        assert_eq!(resolve(base, "https://cdn.example.org/owl.glb").unwrap(), "https://cdn.example.org/owl.glb");
        assert!(resolve("https://example.org", "owl.glb").is_err());
        assert!(resolve("https://example.org?x=1", "owl.glb").is_err());
        assert_eq!(resolve("https://example.org/", "owl.glb").unwrap(), "https://example.org/owl.glb");
        assert_eq!(signature_url("https://example.org/index.json?t=1"), "https://example.org/index.json.sig?t=1");
        assert_eq!(signature_url("https://example.org/index.json"), "https://example.org/index.json.sig");
        for bad in ["../owl.glb", "/owl.glb", "http://x/owl.glb", "file:///etc/passwd", "a//b.glb", "", "a\\b.glb", "x.glb?y"] {
            assert!(resolve(base, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn refuses_http() {
        assert!(fetch("http://example.org/index.json", 10).is_err());
        assert!(check_https("https://example.org/a b").is_err());
    }

    fn entry(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"Owl","version":"1.0.0","author":"A","license":"MIT","url":"{id}.glb","sha256":"{}","size":10}}"#,
            "a".repeat(64)
        )
    }

    #[test]
    fn parses_a_catalog() {
        let index = format!(r#"{{"format":"jeeves-face-catalog/1","faces":[{},{}]}}"#, entry("owl"), entry("fox"));
        let faces = parse_catalog("https://example.org/c/index.json", index.as_bytes()).unwrap();
        assert_eq!(faces.len(), 2);
        assert_eq!(faces[0].url, "https://example.org/c/owl.glb");
        let repeated = format!(r#"{{"format":"jeeves-face-catalog/1","faces":[{},{}]}}"#, entry("owl"), entry("owl"));
        assert!(parse_catalog("https://example.org/index.json", repeated.as_bytes()).is_err());
        let bad_id = format!(r#"{{"format":"jeeves-face-catalog/1","faces":[{}]}}"#, entry("../x"));
        assert!(parse_catalog("https://example.org/index.json", bad_id.as_bytes()).is_err());
        assert!(parse_catalog("https://example.org/index.json", br#"{"format":"other","faces":[]}"#).is_err());
    }

    // Made with scripts/face-catalog.mjs: the key from the seed 0x01 * 32, signing b"jeeves catalog test".
    const KEY: &str = "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";
    const SIG: &str = "a2e38c2e47a380356703eed429285664a9b84fb2e37a01106e93f3334f8ba478438235965c54e280efab24a3334c87333f1f7925a275d3f1406f56a0fe63be0b";

    #[test]
    fn checks_the_signature() {
        let index = b"jeeves catalog test";
        assert!(verify_index(index, KEY, SIG).is_ok());
        assert!(verify_index(b"jeeves catalog tesT", KEY, SIG).is_err());
        assert!(verify_index(index, &"0".repeat(64), SIG).is_err());
        assert!(verify_index(index, KEY, "00").is_err());
    }
}
