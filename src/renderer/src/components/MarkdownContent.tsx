import type { ReactNode } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'

interface MarkdownContentProps {
  content: string
  compact?: boolean
  className?: string
}

function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenRe =
    /(\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_)/g
  let lastIdx = 0
  let match: RegExpExecArray | null
  let idx = 0

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index))
    }
    const key = `${keyPrefix}-${idx++}`
    if (match[2] !== undefined && match[3] !== undefined) {
      const label = match[2]
      const url = match[3]
      if (isSafeHttpUrl(url)) {
        nodes.push(
          <a
            key={key}
            href={url}
            onClick={(e) => {
              e.preventDefault()
              void openUrl(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
            }}
            className="text-emerald-700 dark:text-emerald-400 underline underline-offset-2 hover:opacity-80"
          >
            {renderInline(label, `${key}-a`)}
          </a>
        )
      } else {
        nodes.push(label)
      }
    } else if (match[4] !== undefined) {
      nodes.push(
        <code
          key={key}
          className="px-1.5 py-0.5 rounded bg-slate-200/80 dark:bg-slate-800 text-slate-900 dark:text-emerald-300 font-mono text-[11px]"
        >
          {match[4]}
        </code>
      )
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-slate-900 dark:text-slate-100">
          {match[5] ?? match[6]}
        </strong>
      )
    } else if (match[7] !== undefined) {
      nodes.push(
        <del key={key} className="line-through opacity-75">
          {match[7]}
        </del>
      )
    } else if (match[8] !== undefined || match[9] !== undefined) {
      nodes.push(
        <em key={key} className="italic">
          {match[8] ?? match[9]}
        </em>
      )
    }
    lastIdx = tokenRe.lastIndex
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx))
  }
  return nodes
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  const cells = trimmed.replace(/^\||\|$/g, '').split('|')
  return cells.length >= 1 && cells.every((c) => /^:?-+:?$/.test(c.trim()))
}

function parseTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
}

export function MarkdownContent({ content, compact = false, className = '' }: MarkdownContentProps) {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return null

  const lines = normalized.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let bIdx = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      i++
      continue
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      blocks.push(
        <pre
          key={`code-${bIdx++}`}
          className="p-3 rounded-lg bg-slate-900 text-slate-100 border border-slate-800 font-mono text-[11px] overflow-x-auto"
        >
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(<hr key={`hr-${bIdx++}`} className="border-slate-200 dark:border-slate-800 my-2" />)
      i++
      continue
    }

    // Heading
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      const level = headingMatch[1].length
      const text = headingMatch[2]
      const cls =
        level === 1
          ? 'text-base font-bold text-slate-900 dark:text-slate-100 mt-2'
          : level === 2
            ? 'text-sm font-bold text-slate-900 dark:text-slate-100 mt-1.5'
            : 'text-xs font-bold text-slate-800 dark:text-slate-200 mt-1'
      blocks.push(
        <div key={`h-${bIdx++}`} className={cls}>
          {renderInline(text, `h-${bIdx}`)}
        </div>
      )
      i++
      continue
    }

    // GFM Table
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = parseTableCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
        rows.push(parseTableCells(lines[i]))
        i++
      }
      blocks.push(
        <div key={`tbl-${bIdx++}`} className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-100 dark:bg-slate-900/80 text-slate-800 dark:text-slate-200">
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi} className="px-3 py-1.5 font-semibold border-b border-slate-200 dark:border-slate-800">
                    {renderInline(h, `th-${bIdx}-${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80">
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {headers.map((_, ci) => (
                    <td key={ci} className="px-3 py-1.5 text-slate-600 dark:text-slate-300">
                      {renderInline(r[ci] ?? '', `td-${bIdx}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push(
        <blockquote
          key={`bq-${bIdx++}`}
          className="pl-3 border-l-2 border-emerald-500/70 text-slate-600 dark:text-slate-300 italic space-y-1"
        >
          {quoteLines.map((ql, qi) => (
            <div key={qi}>{renderInline(ql, `bq-${bIdx}-${qi}`)}</div>
          ))}
        </blockquote>
      )
      continue
    }

    // Unordered / Checklist
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: Array<{ checked: boolean | null; text: string }> = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        const rawItem = lines[i].trim().replace(/^[-*+]\s+/, '')
        const chk = /^\[([ xX])\]\s+(.*)$/.exec(rawItem)
        if (chk) {
          items.push({ checked: chk[1].toLowerCase() === 'x', text: chk[2] })
        } else {
          items.push({ checked: null, text: rawItem })
        }
        i++
      }
      blocks.push(
        <ul key={`ul-${bIdx++}`} className="space-y-1 pl-4 list-disc marker:text-emerald-500">
          {items.map((it, ii) => (
            <li key={ii} className={it.checked !== null ? 'list-none -ml-4 flex items-start gap-2' : ''}>
              {it.checked !== null && (
                <span
                  className={`mt-0.5 w-3.5 h-3.5 rounded border inline-flex items-center justify-center text-[10px] shrink-0 ${
                    it.checked
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400'
                      : 'border-slate-500/50'
                  }`}
                >
                  {it.checked ? '✓' : ''}
                </span>
              )}
              <span>{renderInline(it.text, `ul-${bIdx}-${ii}`)}</span>
            </li>
          ))}
        </ul>
      )
      continue
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={`ol-${bIdx++}`} className="space-y-1 pl-5 list-decimal marker:text-slate-400">
          {items.map((it, ii) => (
            <li key={ii}>{renderInline(it, `ol-${bIdx}-${ii}`)}</li>
          ))}
        </ol>
      )
      continue
    }

    // Paragraph
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4}\s+|```|>|[-*+]\s+|\d+\.\s+|-{3,}$|\*{3,}$)/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i])
      i++
    }
    blocks.push(
      <p key={`p-${bIdx++}`} className="whitespace-pre-line">
        {renderInline(paraLines.join('\n'), `p-${bIdx}`)}
      </p>
    )
  }

  return (
    <div
      className={`space-y-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300 ${
        compact ? 'max-h-36 overflow-hidden relative' : ''
      } ${className}`}
    >
      {blocks}
    </div>
  )
}
