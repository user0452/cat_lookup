export function renderMarkdown(text) {
  if (!text) return '';

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let codeLines = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!listType) return;
    output.push(`<${listType}>${listItems.map(item => `<li>${renderInline(item)}</li>`).join('')}</${listType}>`);
    listType = null;
    listItems = [];
  };

  const startListItem = (type, item) => {
    flushParagraph();
    if (listType !== type) {
      flushList();
      listType = type;
    }
    listItems.push(item);
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (codeLines) {
        output.push(`<pre><code>${escapeHtml(codeLines.join('\n').trimEnd())}</code></pre>`);
        codeLines = null;
      } else {
        flushParagraph();
        flushList();
        codeLines = [];
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = /^>\s+(.+)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      output.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = /^[*-]\s+(.+)$/.exec(line);
    if (unordered) {
      startListItem('ul', unordered[1]);
      continue;
    }

    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      startListItem('ol', ordered[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  if (codeLines) {
    output.push(`<pre><code>${escapeHtml(codeLines.join('\n').trimEnd())}</code></pre>`);
  }
  flushParagraph();
  flushList();
  return output.join('');
}

function renderInline(text) {
  const code = [];
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/`([^`]+)`/g, (_, value) => {
    const index = code.push(`<code>${value}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*(.+?)\*/g, '<em>$1</em>');
  return escaped.replace(/\u0000(\d+)\u0000/g, (_, index) => code[Number(index)]);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
