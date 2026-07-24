// Greeting utility — returns a randomized greeting string personalized with the
// user's first name (or a fallback if not set). Greetings are bucketed by time of
// day, then a random entry is drawn once per app session (stable on re-renders via
// the module-level pick at import time).

type Bucket = "morning" | "afternoon" | "evening" | "night"

function bucket(hour: number): Bucket {
  if (hour >= 5 && hour < 12) return "morning"
  if (hour >= 12 && hour < 17) return "afternoon"
  if (hour >= 17 && hour < 21) return "evening"
  return "night"
}

// Template strings: {name} is replaced at runtime, {name?} means name is optional
// (a comma + name is appended only when a name is available).
const greetings: Record<Bucket, string[]> = {
  morning: [
    "Good morning, {name}.",
    "Rise and shine, {name}!",
    "Morning, {name}.",
    "Good morning{name?}.",
    "Hey {name}, good morning!",
    "Morning{name?}!",
  ],
  afternoon: [
    "Good afternoon, {name}.",
    "Hey {name}!",
    "How's the day going{name?}?",
    "Good afternoon{name?}.",
    "Hi {name}!",
    "Welcome back{name?}.",
  ],
  evening: [
    "Good evening, {name}.",
    "Evening{name?}.",
    "Hey {name}, good evening!",
    "Hi {name}!",
    "Winding down{name?}?",
    "Good evening{name?}.",
  ],
  night: [
    "Up late{name?}?",
    "Hey {name}, up late?",
    "Good evening, {name}.",
    "Night owl mode{name?}.",
    "Hi {name}.",
    "Evening{name?}.",
  ],
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** Index frozen at module load so the greeting doesn't change on re-renders. */
const frozenBucket = bucket(new Date().getHours())
const frozenTemplate = pick(greetings[frozenBucket])

/**
 * Returns a greeting string for the given first name.
 *
 * The greeting template is frozen when the module first loads (once per app
 * session), so it stays stable across re-renders but changes on page reload.
 *
 * @param firstName - The user's first name, or null/undefined to omit the name.
 */
export function getGreeting(firstName?: string | null): string {
  const name = firstName?.trim() || null

  if (frozenTemplate.includes("{name?}")) {
    // Optional-name slot: append ", Name" if we have one, strip the slot otherwise.
    return name
      ? frozenTemplate.replace("{name?}", `, ${name}`)
      : frozenTemplate.replace("{name?}", "")
  }

  if (name) {
    return frozenTemplate.replace("{name}", name)
  }

  // No name available but template requires one — fall back to a generic.
  return frozenTemplate
    .replace(", {name}", "")
    .replace(" {name}", "")
    .replace("{name},", "")
    .replace("{name}", "")
    .replace(/\s{2,}/g, " ")
    .trim()
}
