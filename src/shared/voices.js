// Curated voice list: the top 3 female and top 3 male English voices, ranked by the official
// Kokoro-82M VOICES.md grades and by community consensus (af_heart / af_bella are the usual favourites).
export const VOICES = {
  af_heart: { name: "Heart", gender: "Female", accent: "American", grade: "A", lang: "a", tagline: "Warm and natural — the community favourite" },
  af_bella: { name: "Bella", gender: "Female", accent: "American", grade: "A-", lang: "a", tagline: "Expressive and crisp, great for long reads" },
  bf_emma: { name: "Emma", gender: "Female", accent: "British", grade: "B-", lang: "b", tagline: "Soft British narrator" },
  am_michael: { name: "Michael", gender: "Male", accent: "American", grade: "C+", lang: "a", tagline: "Warm, professional" },
  am_fenrir: { name: "Fenrir", gender: "Male", accent: "American", grade: "C+", lang: "a", tagline: "Deep, authoritative" },
  am_puck: { name: "Puck", gender: "Male", accent: "American", grade: "C+", lang: "a", tagline: "Playful, energetic" },
};

export const DEFAULT_VOICE = "af_heart";

export function voiceLabel(id) {
  const v = VOICES[id];
  if (!v) return id;
  return `${v.name} · ${v.accent} ${v.gender} · ${v.grade}`;
}

export function isKnownVoice(id) {
  return Object.prototype.hasOwnProperty.call(VOICES, id);
}
