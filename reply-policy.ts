const TELEGRAM_MESSAGE_LIMIT = 4096;

export function truncateText(value: string, maximumCharacters: number): string {
  const characters = Array.from(value.trim());
  if (characters.length <= maximumCharacters) {
    return characters.join("");
  }

  if (maximumCharacters <= 1) {
    return "…".slice(0, maximumCharacters);
  }

  return `${characters.slice(0, maximumCharacters - 1).join("").trimEnd()}…`;
}

export function isSingleWord(value: string): boolean {
  return value.trim().split(/\s+/u).filter(Boolean).length === 1;
}

export function splitTelegramText(
  value: string,
  maximumCharacters = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  const result: string[] = [];
  let remainder = value.trim();

  while (Array.from(remainder).length > maximumCharacters) {
    const characters = Array.from(remainder);
    const window = characters.slice(0, maximumCharacters).join("");
    const newline = window.lastIndexOf("\n");
    const space = window.lastIndexOf(" ");
    const splitAt = Math.max(newline, space, Math.floor(maximumCharacters * 0.6));
    result.push(window.slice(0, splitAt).trim());
    remainder = `${window.slice(splitAt)}${characters.slice(maximumCharacters).join("")}`.trim();
  }

  if (remainder) {
    result.push(remainder);
  }

  return result;
}
