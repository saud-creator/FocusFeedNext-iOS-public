//! MockXProvider — realistic, deterministic sample data.
//!
//! This exists so the entire application (feed engine, filters, read state,
//! media, groups) can be developed and tested without a live X session
//! and without a single network call. All media are self-contained SVG data
//! URIs, so images render identically offline and in screenshots.
//!
//! Every post here is synthetic content written for this fixture.

use super::XDataProvider;
use crate::models::*;
use chrono::{Duration, Utc};

pub struct MockXProvider {
    seed: u64,
}

impl Default for MockXProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Percent-encode the handful of characters that break an inline `data:` URI.
fn data_svg(svg: &str) -> String {
    let mut out = String::from("data:image/svg+xml;utf8,");
    for c in svg.chars() {
        match c {
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '#' => out.push_str("%23"),
            '%' => out.push_str("%25"),
            '"' => out.push_str("%22"),
            '\n' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

fn avatar(initials: &str, rgb: (u8, u8, u8)) -> String {
    let (r, g, b) = rgb;
    data_svg(&format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'>\
         <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>\
         <stop offset='0' stop-color='rgb({r},{g},{b})'/>\
         <stop offset='1' stop-color='rgb({},{},{})'/></linearGradient></defs>\
         <rect width='96' height='96' rx='48' fill='url(#g)'/>\
         <text x='50' y='50' dy='.35em' text-anchor='middle' font-family='Segoe UI,sans-serif' \
         font-size='36' font-weight='600' fill='rgba(255,255,255,.95)'>{initials}</text></svg>",
        r.saturating_sub(60),
        g.saturating_sub(30),
        b.saturating_add(40)
    ))
}

fn banner(rgb: (u8, u8, u8)) -> String {
    let (r, g, b) = rgb;
    data_svg(&format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='900' height='300'>\
         <defs><linearGradient id='b' x1='0' y1='0' x2='1' y2='1'>\
         <stop offset='0' stop-color='rgb({r},{g},{b})'/>\
         <stop offset='1' stop-color='rgb(18,20,32)'/></linearGradient></defs>\
         <rect width='900' height='300' fill='url(#b)'/></svg>"
    ))
}

fn image(label: &str, w: u32, h: u32, rgb: (u8, u8, u8)) -> PostMedia {
    let (r, g, b) = rgb;
    let url = data_svg(&format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='{w}' height='{h}'>\
         <defs><linearGradient id='i' x1='0' y1='0' x2='1' y2='1'>\
         <stop offset='0' stop-color='rgb({r},{g},{b})'/>\
         <stop offset='1' stop-color='rgb(15,17,26)'/></linearGradient></defs>\
         <rect width='{w}' height='{h}' fill='url(#i)'/>\
         <text x='{}' y='{}' text-anchor='middle' font-family='Segoe UI,sans-serif' \
         font-size='{}' fill='rgba(255,255,255,.82)'>{label}</text></svg>",
        w / 2,
        h / 2,
        (w.min(h) / 9).max(14)
    ));
    PostMedia {
        kind: MediaKind::Image,
        url,
        preview_url: None,
        width: Some(w),
        height: Some(h),
        alt: Some(label.to_string()),
        duration_ms: None,
        variants: vec![],
    }
}

/// An animated SVG stands in for a GIF so looping media is visibly alive.
fn gif(label: &str) -> PostMedia {
    let url = data_svg(&format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='340'>\
         <rect width='600' height='340' fill='rgb(24,26,38)'/>\
         <circle cx='300' cy='170' r='46' fill='rgb(99,102,241)'>\
         <animate attributeName='r' values='34;62;34' dur='1.6s' repeatCount='indefinite'/>\
         <animate attributeName='opacity' values='.45;1;.45' dur='1.6s' repeatCount='indefinite'/>\
         </circle>\
         <text x='300' y='300' text-anchor='middle' font-family='Segoe UI,sans-serif' \
         font-size='20' fill='rgba(255,255,255,.7)'>{label}</text></svg>"
    ));
    PostMedia {
        kind: MediaKind::Gif,
        url,
        preview_url: None,
        width: Some(600),
        height: Some(340),
        alt: Some(label.to_string()),
        duration_ms: Some(1600),
        variants: vec![],
    }
}

/// A video entry. In mock mode there is no decodable stream, so `url` is empty
/// and only a poster is supplied — the player renders an explicit
/// "preview only" state rather than pretending playback works.
fn video(label: &str, seconds: u64) -> PostMedia {
    let poster = image(label, 640, 360, (40, 52, 90)).url;
    PostMedia {
        kind: MediaKind::Video,
        url: String::new(),
        preview_url: Some(poster),
        width: Some(640),
        height: Some(360),
        alt: Some(label.to_string()),
        duration_ms: Some(seconds * 1000),
        // One honest entry. The fixture provider must not invent a quality
        // ladder it cannot serve — `video_media_is_honest_about_playback`
        // enforces that, and it is right to. Real variant handling is covered
        // against real response shapes in `twitter_cli::tests`.
        variants: vec![MediaVariant {
            label: "Auto".into(),
            url: String::new(),
            bitrate: None,
            width: None,
            height: None,
        }],
    }
}

struct Persona {
    id: &'static str,
    username: &'static str,
    name: &'static str,
    initials: &'static str,
    rgb: (u8, u8, u8),
    verified: bool,
    bio: &'static str,
    followers: u64,
    following: u64,
}

const PERSONAS: &[Persona] = &[
    Persona {
        id: "u_1",
        username: "rustlang_daily",
        name: "Rust Daily",
        initials: "RD",
        rgb: (206, 66, 43),
        verified: true,
        bio: "Daily notes on Rust, systems programming and compiler internals.",
        followers: 184_000,
        following: 312,
    },
    Persona {
        id: "u_2",
        username: "ml_papers",
        name: "ML Papers",
        initials: "ML",
        rgb: (72, 101, 214),
        verified: true,
        bio: "Summaries of machine-learning papers, minus the hype.",
        followers: 421_500,
        following: 88,
    },
    Persona {
        id: "u_3",
        username: "dr_amina",
        name: "Dr. Amina Farouk",
        initials: "AF",
        rgb: (23, 148, 122),
        verified: true,
        bio: "Internal medicine. Evidence over anecdote.",
        followers: 96_400,
        following: 540,
    },
    Persona {
        id: "u_4",
        username: "pixel_forge",
        name: "Pixel Forge",
        initials: "PF",
        rgb: (168, 85, 247),
        verified: false,
        bio: "Indie game studio. Devlogs every Friday.",
        followers: 52_100,
        following: 190,
    },
    Persona {
        id: "u_5",
        username: "anime_frames",
        name: "Anime Frames",
        initials: "AN",
        rgb: (236, 72, 153),
        verified: false,
        bio: "Frame-by-frame appreciation of animation craft.",
        followers: 310_200,
        following: 74,
    },
    Persona {
        id: "u_6",
        username: "tech_wire",
        name: "Tech Wire",
        initials: "TW",
        rgb: (14, 165, 233),
        verified: true,
        bio: "Breaking technology news. No sponsored posts.",
        followers: 1_204_000,
        following: 1_502,
    },
    Persona {
        id: "u_7",
        username: "khaled_dev",
        name: "خالد المطيري",
        initials: "خم",
        rgb: (245, 158, 11),
        verified: false,
        bio: "مهندس برمجيات. أكتب عن الأدوات والإنتاجية.",
        followers: 74_800,
        following: 421,
    },
    Persona {
        id: "u_8",
        username: "db_internals",
        name: "DB Internals",
        initials: "DB",
        rgb: (5, 150, 105),
        verified: false,
        bio: "Storage engines, query planners, and write-ahead logs.",
        followers: 63_900,
        following: 205,
    },
    Persona {
        id: "u_9",
        username: "design_notes",
        name: "Design Notes",
        initials: "DN",
        rgb: (99, 102, 241),
        verified: true,
        bio: "Interface design, typography and readable products.",
        followers: 233_000,
        following: 310,
    },
    Persona {
        id: "u_10",
        username: "sec_watch",
        name: "Security Watch",
        initials: "SW",
        rgb: (220, 38, 38),
        verified: true,
        bio: "Vulnerability disclosures and defensive engineering.",
        followers: 512_300,
        following: 96,
    },
    Persona {
        id: "u_11",
        username: "sara_reads",
        name: "Sara Reads",
        initials: "SR",
        rgb: (2, 132, 199),
        verified: false,
        bio: "Long-form reading, notes and annotations.",
        followers: 41_200,
        following: 688,
    },
    Persona {
        id: "u_12",
        username: "open_source_now",
        name: "Open Source Now",
        initials: "OS",
        rgb: (22, 163, 74),
        verified: false,
        bio: "Highlighting maintainers and the tools you already depend on.",
        followers: 128_700,
        following: 402,
    },
];

fn author_of(p: &Persona) -> Author {
    Author {
        id: p.id.to_string(),
        username: p.username.to_string(),
        display_name: p.name.to_string(),
        avatar_url: Some(avatar(p.initials, p.rgb)),
        banner_url: Some(banner(p.rgb)),
        verified: p.verified,
        bio: Some(p.bio.to_string()),
        location: None,
        website: None,
        joined_at: None,
        posts_count: None,
        followers_count: Some(p.followers),
        following_count: Some(p.following),
    }
}

/// (persona index, text, lang) — original synthetic content.
const BODIES: &[(usize, &str, &str)] = &[
    (0, "Spent the morning tracing an allocation that only showed up under load. It was a Vec growing inside a hot loop — reserving capacity once cut p99 latency by a third. The profiler earned its keep today.", "en"),
    (1, "A recurring pattern in this week's papers: smaller models trained longer on cleaner data keep matching much larger ones. The interesting variable is no longer parameter count, it's what you refuse to put in the dataset.", "en"),
    (2, "Reminder for anyone reading study headlines this week: a relative risk reduction of 50% sounds enormous until you learn the absolute risk moved from 0.4% to 0.2%. Always ask for the absolute numbers.", "en"),
    (3, "Devlog 41 — rewrote the lighting pass. The old one recomputed shadow maps every frame even when nothing moved. Now it caches per-light and only invalidates on transform change. Same scene, 22ms → 9ms.", "en"),
    (4, "The thing that makes this sequence work isn't the animation itself, it's the two still frames before it. Holding on stillness makes the motion land harder.", "en"),
    (5, "A major cloud provider is reporting elevated error rates across three regions. Status page acknowledges it; no ETA yet. We'll update as details land.", "en"),
    (6, "أفضل تحسين أجريته هذا الشهر لم يكن في الكود، بل في إغلاق الإشعارات أثناء ساعات العمل العميق. الإنتاجية ليست أدوات فقط، بل حماية للانتباه.", "ar"),
    (7, "Write-ahead logging explained without jargon: before changing the real page, you append what you're about to do to a sequential file. If the machine dies mid-write, you replay the log. That's it. That's the trick.", "en"),
    (8, "Line length matters more than font choice. Somewhere between 60 and 80 characters, reading stops feeling like work. Most dashboards ignore this and stretch text edge to edge.", "en"),
    (9, "Patch released for the deserialization issue disclosed last week. If you run the affected library anywhere that accepts untrusted input, update today rather than at the next sprint boundary.", "en"),
    (10, "Finished a 400-page book by reading 12 pages every morning before opening any feed. No app, no streak counter. Just the same chair and the same time.", "en"),
    (11, "Your dependency tree almost certainly includes a library maintained by one unpaid person. Worth finding out who they are this week.", "en"),
    (0, "Unsafe blocks are not a failure of the language. They're a place where you promise something the compiler can't verify — and the promise should be written down in a comment right above it.", "en"),
    (1, "Evaluation is quietly the hardest part. A benchmark that everyone optimizes against stops measuring capability and starts measuring familiarity with the benchmark.", "en"),
    (3, "Shipped the demo build to playtesters. Three of them found the same corridor confusing, which means it's the corridor, not the players.", "en"),
    (5, "Follow-up: the outage is now attributed to a configuration change that was rolled back. Services are recovering. Root-cause writeup promised within a week.", "en"),
    (8, "Good interfaces don't ask you to remember what you did thirty seconds ago. If the user has to hold state in their head, the app should have held it instead.", "en"),
    (2, "Sleep is not a productivity hack. It's the precondition for everything the productivity hacks are trying to optimize.", "en"),
    (6, "قاعدة بسيطة عند مراجعة الأكواد: إذا احتجت أكثر من دقيقة لفهم دالة، فالمشكلة غالبًا في التسمية وليست في المنطق.", "ar"),
    (11, "Maintainer burnout usually doesn't look like anger. It looks like slower replies, then archived repositories, then silence.", "en"),
    (7, "Index selection is a negotiation: every index you add makes reads faster and writes slower. There is no free index, only ones whose cost you haven't measured yet.", "en"),
    (9, "The most under-rated defensive control is boring: keep an accurate inventory of what you actually run. You cannot patch what you don't know exists.", "en"),
    (4, "Storyboards are compression. A good one tells you what the scene is about in six panels; a bad one tells you what happens in sixty.", "en"),
    (10, "Annotating while reading doubles the time and quadruples what I retain a month later. The margin notes are the actual product.", "en"),
];

impl MockXProvider {
    pub fn new() -> Self {
        Self { seed: 0x5eed_f00d }
    }

    fn rand(&self, n: u64) -> u64 {
        // Deterministic LCG so every run produces the same fixture.
        let mut x = self.seed ^ n.wrapping_mul(0x9E37_79B9_7F4A_7C15);
        x ^= x >> 30;
        x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        x ^= x >> 27;
        x
    }

    fn build_post(&self, i: usize) -> Post {
        let (pi, text, lang) = BODIES[i % BODIES.len()];
        let persona = &PERSONAS[pi];
        let r = self.rand(i as u64);
        let created = Utc::now() - Duration::minutes((i as i64 * 37) % 4_320 + 3);

        let is_repost = i % 7 == 3;
        let is_promoted = i % 11 == 5;
        let has_quote = i % 9 == 4;

        let media = match i % 6 {
            0 => vec![image("Benchmark chart", 900, 506, (37, 52, 92))],
            1 => vec![
                image("Before", 600, 600, (60, 40, 90)),
                image("After", 600, 600, (28, 80, 76)),
            ],
            2 => vec![video("Demo capture", 48)],
            3 => vec![gif("Loading state loop")],
            4 => vec![
                image("Panel 1", 500, 500, (90, 42, 66)),
                image("Panel 2", 500, 500, (42, 66, 90)),
                image("Panel 3", 500, 500, (66, 90, 42)),
            ],
            _ => vec![],
        };

        let quoted = if has_quote {
            let qp = &PERSONAS[(pi + 3) % PERSONAS.len()];
            Some(Box::new(QuotedPost {
                id: format!("mock_q_{i}"),
                author: author_of(qp),
                text: "The original thread this refers to — worth reading in full before forming an opinion.".into(),
                created_at: Some((created - Duration::hours(5)).to_rfc3339()),
                media: vec![],
                url: Some(format!("https://x.com/{}/status/mock_q_{i}", qp.username)),
            }))
        } else {
            None
        };

        let is_article = i % 13 == 6;

        Post {
            id: format!("mock_{i}"),
            text: if is_promoted {
                format!("{text}\n\nLearn more about our platform →")
            } else {
                text.to_string()
            },
            author: author_of(persona),
            created_at: created.to_rfc3339(),
            lang: Some(lang.to_string()),
            is_repost,
            reposted_by: if is_repost {
                Some(author_of(&PERSONAS[(pi + 5) % PERSONAS.len()]))
            } else {
                None
            },
            is_promoted,
            quoted,
            metrics: PostMetrics {
                replies: r % 180,
                reposts: (r >> 7) % 900,
                likes: (r >> 11) % 7_400,
                quotes: (r >> 17) % 120,
                views: (r >> 3) % 240_000 + 500,
                bookmarks: (r >> 23) % 400,
            },
            media,
            url: Some(format!(
                "https://x.com/{}/status/mock_{i}",
                persona.username
            )),
            is_article,
            article_title: if is_article {
                Some("What we learned rewriting our storage layer".into())
            } else {
                None
            },
            in_reply_to: None,
            provider: "mock".into(),
        }
    }

    fn page(&self, offset: usize, max: u32) -> FeedPage {
        let max = max.clamp(1, 100) as usize;
        let posts: Vec<Post> = (offset..offset + max).map(|i| self.build_post(i)).collect();
        FeedPage {
            posts,
            cursor: Some(format!("mock-cursor-{}", offset + max)),
            fetched_at: Utc::now().to_rfc3339(),
            provider: "mock".into(),
            from_cache: false,
        }
    }

    fn offset_of(cursor: &Option<String>) -> usize {
        cursor
            .as_ref()
            .and_then(|c| c.rsplit('-').next().and_then(|n| n.parse::<usize>().ok()))
            .unwrap_or(0)
    }
}

impl XDataProvider for MockXProvider {
    fn name(&self) -> &'static str {
        "mock"
    }

    fn get_following_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        Ok(self.page(Self::offset_of(&cursor), max))
    }

    fn get_for_you_feed(&self, max: u32, cursor: Option<String>) -> AppResult<FeedPage> {
        // Different ordering so the two feeds are visibly distinct.
        let mut page = self.page(Self::offset_of(&cursor) + 5, max);
        page.posts.reverse();
        Ok(page)
    }

    fn get_user_profile(&self, username: &str) -> AppResult<Author> {
        let p = PERSONAS
            .iter()
            .find(|p| {
                p.username
                    .eq_ignore_ascii_case(username.trim_start_matches('@'))
            })
            .unwrap_or(&PERSONAS[0]);
        Ok(author_of(p))
    }

    fn get_user_posts(&self, username: &str, max: u32) -> AppResult<FeedPage> {
        let handle = username.trim_start_matches('@').to_lowercase();
        let all: Vec<Post> = (0..BODIES.len() * 2).map(|i| self.build_post(i)).collect();
        let posts: Vec<Post> = all
            .into_iter()
            .filter(|p| p.author.username.to_lowercase() == handle)
            .take(max as usize)
            .collect();
        Ok(FeedPage {
            posts,
            cursor: None,
            fetched_at: Utc::now().to_rfc3339(),
            provider: "mock".into(),
            from_cache: false,
        })
    }

    fn get_following_accounts(&self, _username: &str, max: u32) -> AppResult<Vec<Author>> {
        Ok(PERSONAS.iter().take(max as usize).map(author_of).collect())
    }

    fn get_bookmarks(&self, max: u32) -> AppResult<FeedPage> {
        let posts: Vec<Post> = (0..max as usize)
            .map(|i| self.build_post(i * 3 + 2))
            .collect();
        Ok(FeedPage {
            posts,
            cursor: None,
            fetched_at: Utc::now().to_rfc3339(),
            provider: "mock".into(),
            from_cache: false,
        })
    }

    fn get_list_timeline(&self, list_id: &str, max: u32) -> AppResult<FeedPage> {
        let bump = list_id.len();
        let posts: Vec<Post> = (0..max as usize)
            .map(|i| self.build_post(i + bump))
            .collect();
        Ok(FeedPage {
            posts,
            cursor: None,
            fetched_at: Utc::now().to_rfc3339(),
            provider: "mock".into(),
            from_cache: false,
        })
    }

    fn get_current_user(&self) -> AppResult<Author> {
        Ok(Author {
            id: "u_self".into(),
            username: "focus_reader".into(),
            display_name: "Focus Reader".into(),
            avatar_url: Some(avatar("FR", (99, 102, 241))),
            banner_url: Some(banner((99, 102, 241))),
            verified: false,
            bio: Some("Fixture account used by the test suite.".into()),
            location: None,
            website: None,
            joined_at: None,
            posts_count: None,
            followers_count: Some(128),
            following_count: Some(PERSONAS.len() as u64),
        })
    }

    fn status(&self) -> AppResult<AuthenticationStatus> {
        Ok(AuthenticationStatus {
            authenticated: false,
            username: Some("focus_reader".into()),
            account: None,
            checked_at: Utc::now().to_rfc3339(),
            message: "Mock provider active - sample data, no live X session.".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_the_requested_number_of_posts() {
        let p = MockXProvider::new();
        let page = p.get_following_feed(20, None).unwrap();
        assert_eq!(page.posts.len(), 20);
    }

    #[test]
    fn is_deterministic() {
        let a = MockXProvider::new().get_following_feed(10, None).unwrap();
        let b = MockXProvider::new().get_following_feed(10, None).unwrap();
        assert_eq!(a.posts[0].id, b.posts[0].id);
        assert_eq!(a.posts[0].metrics, b.posts[0].metrics);
    }

    #[test]
    fn pagination_cursor_advances_without_repeating() {
        let p = MockXProvider::new();
        let one = p.get_following_feed(20, None).unwrap();
        let two = p.get_following_feed(20, one.cursor.clone()).unwrap();
        assert!(one.cursor.is_some());
        let first: std::collections::HashSet<_> = one.posts.iter().map(|p| &p.id).collect();
        assert!(
            two.posts.iter().all(|p| !first.contains(&p.id)),
            "page two repeated page one"
        );
    }

    #[test]
    fn fixture_covers_every_required_shape() {
        let page = MockXProvider::new().get_following_feed(40, None).unwrap();
        assert!(page.posts.iter().any(|p| p.is_repost), "no repost");
        assert!(page.posts.iter().any(|p| p.is_promoted), "no promoted post");
        assert!(
            page.posts.iter().any(|p| p.quoted.is_some()),
            "no quoted post"
        );
        assert!(page.posts.iter().any(|p| p.is_article), "no article");
        assert!(
            page.posts
                .iter()
                .any(|p| p.media.iter().any(|m| m.kind == MediaKind::Image)),
            "no image"
        );
        assert!(
            page.posts
                .iter()
                .any(|p| p.media.iter().any(|m| m.kind == MediaKind::Video)),
            "no video"
        );
        assert!(
            page.posts
                .iter()
                .any(|p| p.media.iter().any(|m| m.kind == MediaKind::Gif)),
            "no gif"
        );
        assert!(
            page.posts.iter().any(|p| p.media.len() > 1),
            "no multi-image post"
        );
        assert!(
            page.posts.iter().any(|p| p.lang.as_deref() == Some("ar")),
            "no RTL post"
        );
    }

    #[test]
    fn media_urls_are_self_contained() {
        let page = MockXProvider::new().get_following_feed(30, None).unwrap();
        for post in &page.posts {
            for m in &post.media {
                let target = if m.kind == MediaKind::Video {
                    m.preview_url.clone().unwrap_or_default()
                } else {
                    m.url.clone()
                };
                assert!(
                    target.starts_with("data:image/svg+xml"),
                    "remote media: {target}"
                );
            }
        }
    }

    #[test]
    fn data_uris_never_contain_a_raw_fragment_marker() {
        // A raw '#' truncates a data: URI at the fragment marker, which
        // silently breaks every image in the app. Gradient references such as
        // url(#g) must survive as %23. This regressed once already.
        let page = MockXProvider::new().get_following_feed(30, None).unwrap();
        for post in &page.posts {
            let avatar = post.author.avatar_url.clone().unwrap_or_default();
            assert!(!avatar.contains('#'), "raw '#' in avatar URI: {avatar}");
            assert!(avatar.contains("%23"), "gradient ref not encoded: {avatar}");
            if let Some(banner) = &post.author.banner_url {
                assert!(!banner.contains('#'), "raw '#' in banner URI");
            }
            for m in &post.media {
                assert!(!m.url.contains('#'), "raw '#' in media URI: {}", m.url);
                if let Some(p) = &m.preview_url {
                    assert!(!p.contains('#'), "raw '#' in preview URI: {p}");
                }
            }
        }
    }

    #[test]
    fn video_media_is_honest_about_playback() {
        let page = MockXProvider::new().get_following_feed(30, None).unwrap();
        let vids: Vec<_> = page
            .posts
            .iter()
            .flat_map(|p| p.media.iter())
            .filter(|m| m.kind == MediaKind::Video)
            .collect();
        assert!(!vids.is_empty());
        // No fabricated quality ladder, and no pretend stream URL.
        for v in vids {
            assert!(v.url.is_empty());
            assert_eq!(v.variants.len(), 1);
            assert_eq!(v.variants[0].label, "Auto");
        }
    }

    #[test]
    fn profiles_resolve_by_handle() {
        let p = MockXProvider::new();
        let a = p.get_user_profile("@ml_papers").unwrap();
        assert_eq!(a.username, "ml_papers");
    }

    #[test]
    fn the_following_list_needs_a_handle_like_the_real_backend() {
        // Mirrors twitter-cli: `following` takes a positional screen name and
        // has no "me" default.
        let p = MockXProvider::new();
        assert_eq!(
            p.get_following_accounts("focus_reader", 3).unwrap().len(),
            3
        );
    }

    #[test]
    fn mock_never_claims_to_be_authenticated() {
        let s = MockXProvider::new().status().unwrap();
        assert!(!s.authenticated);
    }
}
