//! Normalize provider content without dropping authored prose or treating HTML as UI.
use crate::models::{ArticleBlock, ArticleDocument};
use serde_json::Value;
fn image(value: &Value) -> Option<String> {
    if let Some(url) = value
        .as_str()
        .filter(|s| s.starts_with("https://pbs.twimg.com/"))
    {
        return Some(url.into());
    }
    match value {
        Value::Object(map) => map.values().find_map(image),
        Value::Array(rows) => rows.iter().find_map(image),
        _ => None,
    }
}

fn entity<'a>(map: &'a Value, key: &Value) -> Option<&'a Value> {
    let key = key
        .as_str()
        .map(str::to_owned)
        .or_else(|| key.as_u64().map(|n| n.to_string()))?;
    map.get(key.as_str()).or_else(|| {
        map.as_array()?
            .iter()
            .find(|row| {
                row["key"].as_str() == Some(key.as_str())
                    || row["key"].as_u64().map(|n| n.to_string()).as_deref() == Some(key.as_str())
            })
            .and_then(|row| row.get("value"))
    })
}
/// DraftJS offsets count UTF-16 units. Keep linked labels and their authored
/// destinations without splitting a surrogate pair or interpreting raw HTML.
fn linked_text(block: &Value, map: &Value) -> Option<String> {
    let mut text = block["text"].as_str()?.to_owned();
    let mut inserts = Vec::new();
    for range in block["entityRanges"].as_array().into_iter().flatten() {
        let Some(link) = entity(map, &range["key"]).filter(|e| e["type"] == "LINK") else {
            continue;
        };
        let Some(url) = link
            .pointer("/data/url")
            .and_then(Value::as_str)
            .filter(|s| {
                reqwest::Url::parse(s)
                    .ok()
                    .is_some_and(|u| matches!(u.scheme(), "https" | "http"))
            })
        else {
            continue;
        };
        let Some(end) = range["offset"]
            .as_u64()
            .and_then(|offset| offset.checked_add(range["length"].as_u64()?))
        else {
            continue;
        };
        let mut units = 0;
        let mut byte = None;
        for (at, ch) in text.char_indices() {
            if units == end {
                byte = Some(at);
                break;
            }
            units += ch.len_utf16() as u64;
        }
        if units == end && byte.is_none() {
            byte = Some(text.len());
        }
        if let Some(at) = byte {
            inserts.push((at, format!(" ({url})")));
        }
    }
    inserts.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
    for (at, url) in inserts {
        text.insert_str(at, &url);
    }
    Some(text)
}

pub fn article(raw: &Value) -> Option<ArticleDocument> {
    let value = raw.pointer("/article/article_results/result")?;
    let title = value["title"].as_str()?.to_owned();
    let mut blocks: Vec<ArticleBlock> = value
        .pointer("/content_state/blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| {
            if block["type"] == "atomic" {
                let entity = entity(
                    &value["content_state"]["entityMap"],
                    block.pointer("/entityRanges/0/key")?,
                )?;
                if entity["type"] == "MARKDOWN" {
                    return entity
                        .pointer("/data/markdown")
                        .and_then(Value::as_str)
                        .map(|text| ArticleBlock {
                            kind: "code".into(),
                            text: text.into(),
                        });
                }
                let media = image(entity).or_else(|| {
                    let id = entity.pointer("/data/mediaItems/0/mediaId")?.as_str()?;
                    value["media_entities"]
                        .as_array()?
                        .iter()
                        .find(|item| item["media_id"].as_str() == Some(id))
                        .and_then(image)
                });
                return media.map(|url| ArticleBlock {
                    kind: "image".into(),
                    text: url,
                });
            }
            let text = linked_text(block, &value["content_state"]["entityMap"])?;
            let kind = match block["type"].as_str().unwrap_or_default() {
                "header-one" => "heading1",
                "header-two" => "heading2",
                "header-three" => "heading3",
                "blockquote" => "quote",
                "unordered-list-item" => "bullet",
                "ordered-list-item" => "number",
                "code-block" => "code",
                _ => "paragraph",
            };
            Some(ArticleBlock {
                kind: kind.into(),
                text: text.into(),
            })
        })
        .collect();
    if blocks.is_empty() {
        if let Some(text) = value["plain_text"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
        {
            blocks = text
                .split("\n\n")
                .map(|s| ArticleBlock {
                    kind: "paragraph".into(),
                    text: s.into(),
                })
                .collect();
        }
    }
    if blocks.is_empty() {
        return None;
    }
    if let Some(cover) = image(&value["cover_media"]) {
        blocks.insert(
            0,
            ArticleBlock {
                kind: "image".into(),
                text: cover,
            },
        );
    }
    Some(ArticleDocument { title, blocks })
}

/// Remove only provider-identified attachment wrappers; expand ordinary URLs.
pub fn text(raw: &Value, original: &str) -> String {
    let mut links = std::collections::HashMap::<String, String>::new();
    for item in [raw.pointer("/legacy/extended_entities/media"),raw.pointer("/legacy/entities/media")]
        .into_iter().flatten().filter_map(Value::as_array).flatten()
    {
        if let Some(url) = item["url"].as_str() {
            links.insert(url.into(), String::new());
        }
    }
    let quote = raw
        .pointer("/quoted_status_result/result")
        .map(|q| q.get("tweet").unwrap_or(q))
        .filter(|q| {
            q["rest_id"].is_string()
                && q.pointer("/legacy/full_text").is_some()
                && q.pointer("/core/user_results/result").is_some()
        })
        .and_then(|_| raw.pointer("/quoted_status_permalink/expanded"))
        .and_then(Value::as_str);
    for rows in [
        raw.pointer("/legacy/entities/urls"),
        raw.pointer("/note_tweet/note_tweet_results/result/entity_set/urls"),
    ] {
        for item in rows.and_then(Value::as_array).into_iter().flatten() {
            let Some(short) = item["url"].as_str() else {
                continue;
            };
            let expanded = item["expanded_url"].as_str().unwrap_or(short);
            let own_post = reqwest::Url::parse(expanded).ok().is_some_and(|url| {
                matches!(url.host_str(),Some("x.com"|"twitter.com"|"www.x.com"|"www.twitter.com")) && url.path_segments().is_some_and(|mut parts| {
                    let _author=parts.next(); parts.next()==Some("status") && parts.next()==raw["rest_id"].as_str() && raw["rest_id"].is_string()
                })
            });
            let represented = own_post || quote == Some(expanded)
                || (raw
                    .pointer("/article/article_results/result/title")
                    .and_then(Value::as_str)
                    .is_some()
                    && reqwest::Url::parse(expanded).ok().is_some_and(|u| {
                        matches!(u.host_str(), Some("x.com" | "twitter.com"))
                            && u.path().starts_with("/i/article/")
                    }));
            links.entry(short.into()).or_insert_with(|| {
                if represented {
                    String::new()
                } else {
                    expanded.into()
                }
            });
        }
    }
    original
        .split_inclusive(char::is_whitespace)
        .map(|part| {
            let token = part.trim_end_matches(char::is_whitespace);
            let bare=token.trim_matches(|c:char| matches!(c,'('|')'|'['|']'|'{'|'}'|','|'.'|'!'|'?'|';'|':'|'،'|'؛'|'؟'));
            links
                .get(bare)
                .map(|replacement| {let start=token.find(bare).unwrap_or(0);format!("{}{replacement}{}{}",&token[..start],&token[start+bare.len()..],&part[token.len()..])})
                .unwrap_or_else(|| part.into())
        })
        .collect::<String>()
        .trim_end()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn wrappers_are_removed_without_deleting_authored_links_or_paragraphs() {
        let raw = json!({"legacy":{"extended_entities":{"media":[{"url":"https://t.co/media"}]},"entities":{"urls":[{"url":"https://t.co/site","expanded_url":"https://example.com/story"}]}}});
        assert_eq!(
            text(&raw, "مرحبا\n\nRead https://t.co/site\nhttps://t.co/media"),
            "مرحبا\n\nRead https://example.com/story"
        );
        assert_eq!(
            text(&raw, "Keep https://t.co/unknown"),
            "Keep https://t.co/unknown"
        );
    }
    #[test]
    fn attachment_punctuation_and_self_wrappers_do_not_leak_into_prose() {
        let raw=json!({"rest_id":"123","legacy":{"entities":{"media":[{"url":"https://t.co/photo"}],"urls":[{"url":"https://t.co/self","expanded_url":"https://x.com/author/status/123?s=20"},{"url":"https://t.co/other","expanded_url":"https://example.com"}]}}});
        assert_eq!(text(&raw,"Hello\n\nhttps://t.co/photo، https://t.co/self https://t.co/other"),"Hello\n\n،  https://example.com");
    }
    #[test]
    fn articles_keep_full_titles_headings_and_authored_breaks() {
        let raw = json!({"article":{"article_results":{"result":{"title":"عنوان كامل","content_state":{"blocks":[{"type":"header-two","text":"Heading"},{"text":"One\nTwo"},{"text":""}]}}}}});
        let doc = article(&raw).unwrap();
        assert_eq!(doc.title, "عنوان كامل");
        assert_eq!(doc.blocks[0].kind, "heading2");
        assert_eq!(doc.blocks[1].text, "One\nTwo");
        assert_eq!(doc.blocks.len(), 3);
    }
    #[test]
    fn article_entities_accept_numeric_keys_and_preserve_unicode_links_and_literal_embeds() {
        let raw = json!({"article":{"article_results":{"result":{"title":"Title","content_state":{"blocks":[
            {"text":"😀 link","entityRanges":[{"key":1,"offset":3,"length":4}]},
            {"type":"atomic","entityRanges":[{"key":2}]},
            {"type":"atomic","entityRanges":[{"key":3}]}
        ],"entityMap":[
            {"key":1,"value":{"type":"LINK","data":{"url":"https://example.com/source"}}},
            {"key":2,"value":{"type":"MARKDOWN","data":{"markdown":"<iframe>literal</iframe>"}}},
            {"key":3,"value":{"type":"MEDIA","data":{"url":"https://pbs.twimg.com/media/image.jpg"}}}
        ]}}}}});
        let doc = article(&raw).unwrap();
        assert_eq!(doc.blocks[0].text, "😀 link (https://example.com/source)");
        assert_eq!(doc.blocks[1].kind, "code");
        assert_eq!(doc.blocks[1].text, "<iframe>literal</iframe>");
        assert_eq!(doc.blocks[2].kind, "image");
    }
    #[test]
    fn unavailable_quote_links_are_preserved() {
        let raw = json!({"quoted_status_permalink":{"expanded":"https://x.com/user/status/1"},"quoted_status_result":{"result":{"__typename":"TweetUnavailable"}},"legacy":{"entities":{"urls":[{"url":"https://t.co/quote","expanded_url":"https://x.com/user/status/1"}]}}});
        assert_eq!(
            text(&raw, "Read https://t.co/quote"),
            "Read https://x.com/user/status/1"
        );
    }
}
