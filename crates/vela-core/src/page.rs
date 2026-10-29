//! The page of a space: free Markdown kept next to the space (`spaces/<id>.md`), never in a
//! repo. Links, notes, commands, whatever the task needs.

use std::fs;

use crate::error::Result;
use crate::model::Space;
use crate::{Vela, paths};

/// The page as it is on disk, or a first page made from the space: its ticket and the links
/// added by hand, so nothing is lost.
pub fn read(vela: &Vela, space: &Space) -> Result<String> {
    match fs::read_to_string(paths::space_page(&vela.home, &space.id)) {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(first_page(space)),
        Err(e) => Err(e.into()),
    }
}

pub fn write(vela: &Vela, id: &str, text: &str) -> Result<()> {
    fs::create_dir_all(paths::spaces_dir(&vela.home))?;
    let path = paths::space_page(&vela.home, id);
    // Write then rename: a crash never leaves half a page.
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn delete(vela: &Vela, id: &str) {
    let _ = fs::remove_file(paths::space_page(&vela.home, id));
}

fn first_page(space: &Space) -> String {
    let mut out = format!("# {}\n\n", space.name);
    let mut links: Vec<String> = Vec::new();
    if let Some(t) = &space.ticket {
        links.push(format!("- Ticket: {t}"));
    }
    for l in &space.links {
        if l.url.is_empty() {
            continue;
        }
        links.push(if l.title.is_empty() || l.title == l.url {
            format!("- <{}>", l.url)
        } else {
            format!("- [{}]({})", l.title.replace(']', "\\]"), l.url)
        });
    }
    if !links.is_empty() {
        out.push_str("## Links\n\n");
        out.push_str(&links.join("\n"));
        out.push_str("\n\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Link, LinkKind, LinkSource, Provider};

    fn space() -> Space {
        Space {
            id: "refunds".into(),
            name: "Refunds".into(),
            color: "#E8A14A".into(),
            branch: "main".into(),
            repos: vec![],
            created_at: "2026-10-29T00:00:00Z".into(),
            window: None,
            archived: false,
            links: vec![Link {
                id: "x".into(),
                kind: LinkKind::Doc,
                provider: Provider::Url,
                url: "https://docs.acme.io/refunds".into(),
                title: "Refund spec".into(),
                key: None,
                source: LinkSource::Manual,
                summary: None,
            }],
            ticket: Some("PAY-412".into()),
        }
    }

    #[test]
    fn a_new_page_keeps_the_ticket_and_the_links_then_is_saved_as_typed() {
        let tmp = tempfile::tempdir().unwrap();
        let vela = Vela::new(tmp.path());
        let s = space();
        let first = read(&vela, &s).unwrap();
        assert!(first.starts_with("# Refunds\n"));
        assert!(first.contains("- Ticket: PAY-412"));
        assert!(first.contains("- [Refund spec](https://docs.acme.io/refunds)"));
        write(&vela, &s.id, "my notes\n").unwrap();
        assert_eq!(read(&vela, &s).unwrap(), "my notes\n");
        delete(&vela, &s.id);
        assert!(read(&vela, &s).unwrap().starts_with("# Refunds"));
    }
}
