import type { ReactNode } from 'react'

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: Array<{ text: string; depth: number; checked: boolean | null }> }
  | { kind: 'paragraph'; text: string }

const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/

function parse(markdown: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }

  for (const line of markdown.split('\n')) {
    const heading = HEADING.exec(line)
    const item = LIST_ITEM.exec(line)
    if (heading) {
      endParagraph()
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! })
    } else if (item) {
      endParagraph()
      const ordered = /\d/.test(item[2]!)
      const last = blocks.at(-1)
      const entry = {
        text: item[4]!,
        depth: Math.min(3, Math.floor(item[1]!.replace(/\t/g, '  ').length / 2)),
        checked: item[3] === undefined ? null : item[3] !== ' ',
      }
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(entry)
      else blocks.push({ kind: 'list', ordered, items: [entry] })
    } else if (line.trim() === '' || /^(-{3,}|\*{3,})\s*$/.test(line)) {
      endParagraph()
    } else {
      paragraph.push(line.trim())
    }
  }
  endParagraph()
  return blocks
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (/^(\*\*|__).+\1$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (/^`.+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>
    if (/^([*_]).+\1$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>
    return part
  })
}

/** Renders the subset of Markdown that meeting summaries use, without injecting HTML. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      {parse(text).map((block, i) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = block.level <= 2 ? 'h4' : 'h5'
            return <Tag key={i}>{inline(block.text)}</Tag>
          }
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul'
            return (
              <List key={i}>
                {block.items.map((item, j) => (
                  <li
                    key={j}
                    className={item.checked === null ? undefined : 'task'}
                    style={item.depth ? { marginLeft: item.depth * 18 } : undefined}
                  >
                    {item.checked !== null && <input type="checkbox" checked={item.checked} readOnly />}
                    {inline(item.text)}
                  </li>
                ))}
              </List>
            )
          }
          case 'paragraph':
            return <p key={i}>{inline(block.text)}</p>
          default: {
            const unreachable: never = block
            throw new Error(`unhandled markdown block ${JSON.stringify(unreachable)}`)
          }
        }
      })}
    </div>
  )
}
