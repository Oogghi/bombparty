export function normalizeWord(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr-FR")
    .replace(/[^a-z]/g, "");
}

export function createLexicon(words) {
  const normalizedWords = new Set();
  for (const word of words) {
    const normalized = normalizeWord(word);
    if (normalized.length >= 3 && normalized.length <= 32) normalizedWords.add(normalized);
  }

  const byFragment = new Map();
  for (const word of normalizedWords) {
    const fragments = new Set();
    for (let length = 2; length <= 3; length += 1) {
      for (let index = 0; index <= word.length - length; index += 1) {
        fragments.add(word.slice(index, index + length));
      }
    }
    for (const fragment of fragments) {
      const matches = byFragment.get(fragment) ?? [];
      matches.push(word);
      byFragment.set(fragment, matches);
    }
  }

  return { words: normalizedWords, byFragment };
}

export function findFragmentIndex(normalizedWord, fragment) {
  const index = normalizedWord.indexOf(fragment);
  return index < 0 ? -1 : index;
}
