import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Author,
  Post,
  PostMedia,
  QuotedPost,
  SessionSnapshot,
} from "@/lib/api";
import { TooltipProvider } from "@/components/ui/primitives";
import { I18nProvider, type Locale } from "@/i18n";

export function makeAuthor(over: Partial<Author> = {}): Author {
  return {
    id: "u_1",
    username: "rustlang_daily",
    displayName: "Rust Daily",
    avatarUrl:
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
    bannerUrl: null,
    verified: true,
    bio: "Systems programming notes",
    followersCount: 184000,
    followingCount: 312,
    ...over,
  };
}

export function makeImage(over: Partial<PostMedia> = {}): PostMedia {
  return {
    kind: "image",
    url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
    previewUrl: null,
    width: 800,
    height: 600,
    alt: "Benchmark chart",
    durationMs: null,
    variants: [],
    ...over,
  };
}

export function makeVideo(over: Partial<PostMedia> = {}): PostMedia {
  return {
    kind: "video",
    url: "",
    previewUrl:
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
    width: 640,
    height: 360,
    alt: "Demo capture",
    durationMs: 48000,
    variants: [{ label: "Auto", url: "", bitrate: null }],
    ...over,
  };
}

export function makeQuoted(over: Partial<QuotedPost> = {}): QuotedPost {
  return {
    id: "q_1",
    author: makeAuthor({
      id: "u_2",
      username: "ml_papers",
      displayName: "ML Papers",
    }),
    text: "The original thread being referenced here.",
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    media: [],
    url: "https://x.com/ml_papers/status/q_1",
    ...over,
  };
}

export function makePost(over: Partial<Post> = {}): Post {
  return {
    id: "p_1",
    text: "Reserving capacity once cut our p99 latency by a third.",
    author: makeAuthor(),
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    lang: "en",
    isRepost: false,
    repostedBy: null,
    isPromoted: false,
    quoted: null,
    metrics: {
      replies: 4,
      reposts: 12,
      likes: 240,
      quotes: 2,
      views: 9800,
      bookmarks: 7,
    },
    media: [],
    url: "https://x.com/rustlang_daily/status/p_1",
    isArticle: false,
    articleTitle: null,
    inReplyTo: null,
    provider: "mock",
    ...over,
  };
}

export function makeSnapshot(
  over: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    state: "disconnected",
    reason: "no_credentials",
    checking: false,
    account: null,
    checkedAt: null,
    lastSuccessAt: null,
    hasCredentials: false,
    detail: null,
    ...over,
  };
}

export function renderWithProviders(
  ui: ReactElement,
  { locale = "en" as Locale }: { locale?: Locale } = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={client}>
      <I18nProvider locale={locale}>
        <TooltipProvider>{node}</TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(ui));
  // Testing Library's rerender replaces the whole tree, which would otherwise
  // drop the providers and break any component using a Radix context.
  return {
    ...result,
    rerender: (node: ReactElement) => result.rerender(wrap(node)),
  };
}
