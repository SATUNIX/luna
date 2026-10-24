// Generated from packages/web-ui/src/public/js/markdown.ts by `npm run build:web` (internal/docs/adr/0002).
// Edit the TypeScript source, not this file.
// markdown.ts — a small, dependency-free markdown renderer for chat messages.
//
// Security: this never parses HTML from the model or the session files. Every piece of source
// text becomes a text node, so `<script>` in a message renders as literal characters. Links are
// scheme-checked (http/https/mailto only). There is no innerHTML anywhere in this module.
const LINK_SCHEMES = /^(https?:|mailto:)/i;
const KEYWORDS = new Map(Object.entries({
    js: "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|new|await|async|import|export|from|default|try|catch|finally|throw|typeof|instanceof|in|of|this|null|undefined|true|false|delete|yield|static|get|set|super",
    python: "def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|with|lambda|pass|raise|yield|assert|global|nonlocal|del|in|is|not|and|or|None|True|False|async|await|self",
    bash: "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|readonly|echo|cd|set|source|unset|exit|trap",
    json: "true|false|null",
    yaml: "true|false|null|yes|no",
    go: "func|package|import|return|if|else|for|range|var|const|type|struct|interface|map|chan|go|defer|select|switch|case|break|continue|nil|true|false",
    rust: "fn|let|mut|const|struct|enum|impl|trait|pub|use|mod|return|if|else|match|for|while|loop|in|as|where|self|Self|true|false|Some|None|Ok|Err",
    sql: "SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|ON|GROUP|BY|ORDER|LIMIT|OFFSET|AND|OR|NOT|NULL|AS|DISTINCT|COUNT|SUM|AVG|MIN|MAX",
    sh: "if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|echo|cd|set|source|exit",
}));
const COMMENT_STYLE = new Map(Object.entries({
    js: "slash",
    ts: "slash",
    go: "slash",
    rust: "slash",
    css: "block",
    sql: "dash",
    json: null,
    python: "hash",
    bash: "hash",
    sh: "hash",
    yaml: "hash",
}));
const LANG_ALIASES = new Map(Object.entries({
    javascript: "js",
    jsx: "js",
    node: "js",
    mjs: "js",
    cjs: "js",
    typescript: "ts",
    tsx: "ts",
    py: "python",
    python3: "python",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    golang: "go",
    rs: "rust",
    postgres: "sql",
    psql: "sql",
    jsonc: "json",
    html: "xml",
    htm: "xml",
}));
function normalizeLang(lang) {
    const l = lang.toLowerCase();
    return LANG_ALIASES.get(l) || l;
}
// ------------------------------------------------------------------ inline --
function linkNode(label, href) {
    if (!LINK_SCHEMES.test(href)) {
        // Unsafe/unknown scheme: keep the visible text, drop the link.
        const span = document.createElement("span");
        span.appendChild(document.createTextNode(`${label} (${href})`));
        return span;
    }
    const a = document.createElement("a");
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    a.appendChild(document.createTextNode(label));
    return a;
}
// Italic: `*x*` anywhere, but `_x_` only at word boundaries — CommonMark does not treat
// intraword underscores as emphasis, and snake_case identifiers are common in agent output.
const INLINE_PATTERN = [
    "(?<code>`[^`\\n]+`)",
    "(?<bold>\\*\\*[^*\\n]+\\*\\*)",
    "(?<strike>~~[^~\\n]+~~)",
    "(?<italic>\\*[^*\\n]+\\*|(?<![\\w])_[^_\\n]+_(?![\\w]))",
    "(?<link>\\[[^\\]\\n]*\\]\\([^)\\s]+\\))",
    "(?<url>https?://[^\\s<>()\"']+)",
].join("|");
/**
 * A fresh regex per call is required: renderInline() recurses (bold/italic contents) and a
 * shared /g regex would have its lastIndex reset by the inner call, restarting the outer scan
 * forever (which exhausts memory).
 */
function inlineRegex() {
    return new RegExp(INLINE_PATTERN, "g");
}
/** Turn inline markdown into a DocumentFragment of real DOM nodes. */
export function renderInline(text) {
    const frag = document.createDocumentFragment();
    const src = text ?? "";
    const re = inlineRegex();
    let last = 0;
    let match;
    while ((match = re.exec(src))) {
        if (match.index > last)
            frag.appendChild(document.createTextNode(src.slice(last, match.index)));
        const g = match.groups ?? {};
        if (g.code) {
            const code = document.createElement("code");
            code.className = "md-inline-code";
            code.appendChild(document.createTextNode(g.code.slice(1, -1)));
            frag.appendChild(code);
        }
        else if (g.bold) {
            const strong = document.createElement("strong");
            strong.appendChild(renderInline(g.bold.slice(2, -2)));
            frag.appendChild(strong);
        }
        else if (g.strike) {
            const del = document.createElement("del");
            del.appendChild(document.createTextNode(g.strike.slice(2, -2)));
            frag.appendChild(del);
        }
        else if (g.italic) {
            const em = document.createElement("em");
            em.appendChild(renderInline(g.italic.slice(1, -1)));
            frag.appendChild(em);
        }
        else if (g.link) {
            const parts = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(g.link);
            if (parts)
                frag.appendChild(linkNode(parts[1] ?? "", parts[2] ?? ""));
            else
                frag.appendChild(document.createTextNode(g.link));
        }
        else if (g.url) {
            frag.appendChild(linkNode(g.url, g.url));
        }
        else {
            frag.appendChild(document.createTextNode(match[0]));
        }
        last = match.index + match[0].length;
    }
    if (last < src.length)
        frag.appendChild(document.createTextNode(src.slice(last)));
    return frag;
}
function highlightFragment(code, lang) {
    const frag = document.createDocumentFragment();
    const spec = COMMENT_STYLE.get(lang);
    const keywords = KEYWORDS.get(lang);
    const pieces = [];
    const alternates = [];
    if (spec === "slash")
        alternates.push("(?<comment>\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)");
    if (spec === "hash")
        alternates.push("(?<comment>#[^\\n]*)");
    if (spec === "dash")
        alternates.push("(?<comment>--[^\\n]*)");
    if (spec === "block")
        alternates.push("(?<comment>\\/\\*[\\s\\S]*?\\*\\/)");
    alternates.push("(?<str>\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)");
    alternates.push("(?<num>\\b0[xX][0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)");
    if (keywords)
        alternates.push(`(?<kw>\\b(?:${keywords})\\b)`);
    alternates.push("(?<fn>[A-Za-z_$][\\w$]*)(?=\\s*\\()");
    let re;
    try {
        re = new RegExp(alternates.join("|"), "g");
    }
    catch {
        return frag;
    }
    let last = 0;
    let m;
    while ((m = re.exec(code))) {
        if (m.index > last)
            pieces.push({ kind: null, text: code.slice(last, m.index) });
        const g = m.groups ?? {};
        const kind = g.comment
            ? "comment"
            : g.str
                ? "string"
                : g.num
                    ? "number"
                    : g.kw
                        ? "keyword"
                        : g.fn
                            ? "function"
                            : null;
        pieces.push({ kind, text: m[0] });
        last = m.index + m[0].length;
        if (m[0].length === 0)
            re.lastIndex++;
    }
    if (last < code.length)
        pieces.push({ kind: null, text: code.slice(last) });
    for (const piece of pieces) {
        if (!piece.kind) {
            frag.appendChild(document.createTextNode(piece.text));
            continue;
        }
        const span = document.createElement("span");
        span.className = `md-tok md-tok-${piece.kind}`;
        span.appendChild(document.createTextNode(piece.text));
        frag.appendChild(span);
    }
    return frag;
}
// ----------------------------------------------------------------- blocks ---
function codeBlock(code, lang) {
    const box = document.createElement("div");
    box.className = "md-code";
    if (lang) {
        const tag = document.createElement("div");
        tag.className = "md-code-lang";
        tag.appendChild(document.createTextNode(lang));
        box.appendChild(tag);
    }
    const pre = document.createElement("pre");
    pre.className = "md-code-pre";
    const codeEl = document.createElement("code");
    codeEl.appendChild(highlightFragment(code, normalizeLang(lang)));
    pre.appendChild(codeEl);
    box.appendChild(pre);
    return box;
}
function listNode(ordered, items) {
    const list = document.createElement(ordered ? "ol" : "ul");
    for (const item of items) {
        const li = document.createElement("li");
        li.appendChild(renderInline(item));
        list.appendChild(li);
    }
    return list;
}
function tableNode(rows) {
    const table = document.createElement("table");
    table.className = "md-table";
    rows.forEach((cells, index) => {
        const tr = document.createElement("tr");
        for (const cell of cells) {
            const el = document.createElement(index === 0 ? "th" : "td");
            el.appendChild(renderInline(cell));
            tr.appendChild(el);
        }
        table.appendChild(tr);
    });
    return table;
}
function splitRow(line) {
    return line
        .replace(/^\s*\|/, "")
        .replace(/\|\s*$/, "")
        .split("|")
        .map((c) => c.trim());
}
/** Render markdown text into a DocumentFragment. */
export function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    const lines = (text ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n");
    let i = 0;
    // In-range reads only (every caller checks `i < lines.length` first).
    const at = (n) => lines[n] ?? "";
    const flushParagraph = (buffer) => {
        if (!buffer.length)
            return;
        const p = document.createElement("p");
        // Single newlines inside a paragraph become line breaks (chat-like, not prose-like).
        buffer.forEach((line, index) => {
            if (index > 0)
                p.appendChild(document.createElement("br"));
            p.appendChild(renderInline(line));
        });
        frag.appendChild(p);
    };
    let paragraph = [];
    while (i < lines.length) {
        const line = at(i);
        const fence = /^\s*```+\s*([\w+#.-]*)\s*$/.exec(line);
        if (fence) {
            flushParagraph(paragraph);
            paragraph = [];
            const lang = fence[1] || "";
            const body = [];
            i++;
            while (i < lines.length && !/^\s*```+\s*$/.test(at(i))) {
                body.push(at(i));
                i++;
            }
            i++; // consume the closing fence
            frag.appendChild(codeBlock(body.join("\n"), lang));
            continue;
        }
        const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            flushParagraph(paragraph);
            paragraph = [];
            // Map into h3..h6 so message headings don't outrank the app's own headings.
            const level = Math.min((heading[1] ?? "").length + 2, 6);
            const h = document.createElement(`h${level}`);
            h.className = "md-h";
            h.appendChild(renderInline(heading[2]));
            frag.appendChild(h);
            i++;
            continue;
        }
        if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
            flushParagraph(paragraph);
            paragraph = [];
            frag.appendChild(document.createElement("hr"));
            i++;
            continue;
        }
        // Table: header row followed by a separator row of dashes/pipes.
        if (line.includes("|") &&
            i + 1 < lines.length &&
            /^\s*\|?[\s:|-]+\|?\s*$/.test(at(i + 1)) &&
            at(i + 1).includes("-")) {
            flushParagraph(paragraph);
            paragraph = [];
            const rows = [splitRow(line)];
            i += 2;
            while (i < lines.length && at(i).includes("|") && at(i).trim()) {
                rows.push(splitRow(at(i)));
                i++;
            }
            frag.appendChild(tableNode(rows));
            continue;
        }
        if (/^\s{0,3}>\s?/.test(line)) {
            flushParagraph(paragraph);
            paragraph = [];
            const quote = [];
            while (i < lines.length && /^\s{0,3}>\s?/.test(at(i))) {
                quote.push(at(i).replace(/^\s{0,3}>\s?/, ""));
                i++;
            }
            const blockquote = document.createElement("blockquote");
            blockquote.className = "md-quote";
            const inner = renderMarkdown(quote.join("\n"));
            blockquote.appendChild(inner);
            frag.appendChild(blockquote);
            continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (bullet || ordered) {
            flushParagraph(paragraph);
            paragraph = [];
            const isOrdered = Boolean(ordered);
            const items = [];
            while (i < lines.length) {
                const b = /^\s*[-*+]\s+(.*)$/.exec(at(i));
                const o = /^\s*\d+[.)]\s+(.*)$/.exec(at(i));
                if (isOrdered && o)
                    items.push(o[1] ?? "");
                else if (!isOrdered && b)
                    items.push(b[1] ?? "");
                else
                    break;
                i++;
            }
            frag.appendChild(listNode(isOrdered, items));
            continue;
        }
        if (!line.trim()) {
            flushParagraph(paragraph);
            paragraph = [];
            i++;
            continue;
        }
        paragraph.push(line);
        i++;
    }
    flushParagraph(paragraph);
    if (!frag.hasChildNodes())
        frag.appendChild(document.createTextNode(text ?? ""));
    return frag;
}
/** Convenience: render markdown into an existing element, replacing its content. */
export function renderMarkdownInto(node, text) {
    node.replaceChildren(renderMarkdown(text));
}
