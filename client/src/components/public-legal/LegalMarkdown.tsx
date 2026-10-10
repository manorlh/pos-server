/**
 * A legal page's text (limited markdown, lib/legalDocs.ts) as plain React elements — headings,
 * paragraphs, lists and bold. No HTML from the text ever reaches the page.
 *
 * `headingOffset` shifts levels when the page already has its own h1 (the document's `#` becomes h2).
 */
import { Fragment } from 'react';
import { parseInline, parseLimitedMarkdown, type MdBlock } from '../../lib/legalDocs';

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.type === 'strong' ? <strong key={i}>{part.text}</strong> : <Fragment key={i}>{part.text}</Fragment>,
      )}
    </>
  );
}

function Heading({ level, text }: { level: number; text: string }) {
  const clamped = Math.min(Math.max(level, 1), 6);
  const cls =
    clamped <= 1 ? 'text-2xl font-bold' : clamped === 2 ? 'mt-6 text-lg font-semibold' : 'mt-4 text-base font-semibold';
  const Tag = `h${clamped}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  return (
    <Tag className={cls}>
      <Inline text={text} />
    </Tag>
  );
}

function Block({ block, headingOffset }: { block: MdBlock; headingOffset: number }) {
  switch (block.type) {
    case 'h1':
    case 'h2':
    case 'h3':
      return <Heading level={Number(block.type[1]) + headingOffset} text={block.text} />;
    case 'ul':
      return (
        <ul className="list-disc space-y-1 ps-6">
          {block.items.map((item, i) => (
            <li key={i}>
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    default:
      return (
        <p>
          {block.lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 ? <br /> : null}
              <Inline text={line} />
            </Fragment>
          ))}
        </p>
      );
  }
}

export function LegalMarkdown({ text, headingOffset = 0 }: { text: string; headingOffset?: number }) {
  return (
    <div className="space-y-3 leading-relaxed">
      {parseLimitedMarkdown(text).map((block, i) => (
        <Block key={i} block={block} headingOffset={headingOffset} />
      ))}
    </div>
  );
}
