//! Spaces persisted as `spaces/<id>.toml`.

use std::fs;

use crate::Vela;
use crate::error::{Error, Result};
use crate::model::Space;
use crate::paths;

pub fn save(vela: &Vela, space: &Space) -> Result<()> {
    fs::create_dir_all(paths::spaces_dir(&vela.home))?;
    let text = toml::to_string_pretty(space)?;
    fs::write(paths::space_file(&vela.home, &space.id), text)?;
    Ok(())
}

pub fn exists(vela: &Vela, id: &str) -> bool {
    paths::space_file(&vela.home, id).is_file()
}

pub fn load(vela: &Vela, id: &str) -> Result<Space> {
    let path = paths::space_file(&vela.home, id);
    match fs::read_to_string(&path) {
        Ok(text) => {
            let mut s: Space = toml::from_str(&text)?;
            s.normalize();
            Ok(s)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(Error::SpaceNotFound(id.to_string()))
        }
        Err(e) => Err(e.into()),
    }
}

/// All spaces, oldest first.
pub fn list(vela: &Vela) -> Result<Vec<Space>> {
    let dir = paths::spaces_dir(&vela.home);
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut spaces = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("toml") {
            let mut s = toml::from_str::<Space>(&fs::read_to_string(&path)?)?;
            s.normalize();
            spaces.push(s);
        }
    }
    spaces.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    Ok(spaces)
}

pub fn delete(vela: &Vela, id: &str) -> Result<()> {
    match fs::remove_file(paths::space_file(&vela.home, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(Error::SpaceNotFound(id.to_string()))
        }
        Err(e) => Err(e.into()),
    }
}
