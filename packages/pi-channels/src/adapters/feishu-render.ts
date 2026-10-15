function codeEnd(text: string, start: number, delimiterLength: number): number | undefined {
  const offset = start + delimiterLength;
  for (const match of text.slice(offset).matchAll(/`+/g)) {
    if (match[0].length === delimiterLength) return offset + match.index + delimiterLength;
  }
  return undefined;
}

// Split only real table delimiters; pipes in inline code or escaped cells are data.
function cells(line: string): string[] {
  const result: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      cell += line.slice(i, i + 2);
      i++;
    } else if (char === '`') {
      const run = line.slice(i).match(/^`+/)![0];
      const end = codeEnd(line, i, run.length);
      cell += line.slice(i, end ?? i + run.length);
      i = (end ?? i + run.length) - 1;
    } else if (char === '|') {
      result.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  result.push(cell.trim());
  if (line.trimStart().startsWith('|')) result.shift();
  if (line.trimEnd().endsWith('|') && result.at(-1) === '') result.pop();
  return result;
}

function stripFormatting(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|~~)(.*?)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.*?)__(?![\p{L}\p{N}_])/gu, '$1');
}

function plainText(text: string): string {
  let result = '';
  let cursor = 0;
  for (const match of text.matchAll(/\\[\\`*_[\]{}()#+\-.!|>~]|`+/g)) {
    if (match.index < cursor) continue;
    const escaped = match[0].startsWith('\\');
    const end = escaped
      ? match.index + match[0].length
      : codeEnd(text, match.index, match[0].length);
    if (end === undefined) continue;
    result += stripFormatting(text.slice(cursor, match.index));
    result += escaped
      ? match[0].slice(1)
      : text.slice(match.index + match[0].length, end - match[0].length);
    cursor = end;
  }
  return result + stripFormatting(text.slice(cursor));
}

function markdownFence(line: string, fence: string | undefined): string | undefined {
  const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!marker) return fence;
  const delimiter = marker[1]!;
  const suffix = marker[2]!;
  if (fence)
    return delimiter[0] === fence[0] && delimiter.length >= fence.length && !suffix.trim()
      ? undefined
      : fence;
  return delimiter.startsWith('`') && suffix.includes('`') ? undefined : delimiter;
}

/** Keep each fenced block in its own md row so Feishu does not swallow trailing prose. */
export function buildFeishuPost(text: string) {
  const rows: { tag: 'md'; text: string }[][] = [];
  let current: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const segment = current.join('\n');
    if (segment.trim()) rows.push([{ tag: 'md', text: segment }]);
    current = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const nextFence = markdownFence(line, fence);
    if (!fence && nextFence) flush();
    current.push(line);
    if (fence && !nextFence) flush();
    fence = nextFence;
  }
  flush();
  return { zh_cn: { content: rows.length ? rows : [[{ tag: 'md', text }]] } };
}

/** Expand tables only for the plain-text fallback, without display-width assumptions. */
export function renderFeishuPlainText(text: string): string {
  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const nextFence = markdownFence(line, fence);
    if (fence) {
      if (nextFence) output.push(line);
      fence = nextFence;
      continue;
    }
    if (nextFence) {
      fence = nextFence;
      continue;
    }
    const header = cells(line);
    const separator = cells(lines[i + 1] ?? '');
    if (
      !/^\s{4}/.test(line) &&
      line.includes('|') &&
      header.length > 0 &&
      separator.length === header.length &&
      separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      i++;
      const rows: string[] = [];
      while (
        i + 1 < lines.length &&
        lines[i + 1]!.includes('|') &&
        !/^ {0,3}(`{3,}|~{3,})/.test(lines[i + 1]!)
      ) {
        const row = cells(lines[++i]!);
        // Preserve extra cells rather than silently dropping malformed table data.
        rows.push(
          Array.from(
            { length: Math.max(header.length, row.length) },
            (_, column) =>
              `${plainText(header[column] || String(column + 1))}：${plainText(row[column] ?? '')}`,
          ).join('\n'),
        );
      }
      output.push(rows.length ? rows.join('\n\n') : header.map(plainText).join(' / '));
      continue;
    }
    output.push(plainText(line.replace(/^ {0,3}#{1,6}\s+/, '').replace(/^ {0,3}>\s?/, '')));
  }
  return output.join('\n');
}
