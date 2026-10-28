import { expect, test } from 'vitest'
import { citedResponse } from '../src/lib/llm/response.js'

function response(content: string, citations: readonly unknown[]) {
  return {
    content,
    additional_kwargs: {
      __raw_response: {
        venice_parameters: { web_search_citations: citations },
      },
    },
  }
}

test.each([true, false])(
  'links native citation markers with source list enabled=%s',
  (includeSourceList) => {
    const content =
      'Claim.^2^ Together.^1, 2^ Another claim [1]. Existing [link](https://example.com).'
    const linked =
      'Claim.[2](<https://two.example/b>) Together.[1](<https://one.example/a>), [2](<https://two.example/b>) Another claim [1]. Existing [link](https://example.com).'
    const answer = citedResponse(
      response(content, [
        { url: 'https://one.example/a' },
        { url: 'https://two.example/b' },
      ]),
      { includeSourceList }
    )
    expect(answer).toBe(
      includeSourceList
        ? `${linked}\n\nSources:\n- [Source 1](<https://one.example/a>)\n- [Source 2](<https://two.example/b>)`
        : linked
    )
  }
)

test.each(['Sources:', '## References', '**Fuentes**:'])(
  'preserves a native trailing %s list without adding another list in groups',
  (heading) => {
    const content = `Claim [1].\n\n${heading}\n1. [Article](https://example.com/article)`
    expect(
      citedResponse(
        { content, additional_kwargs: {} },
        { includeSourceList: false }
      )
    ).toBe(content)
    expect(citedResponse({ content, additional_kwargs: {} })).toBe(content)
  }
)

test('preserves source headings inside code and substantive text after a source heading', () => {
  for (const content of [
    '```markdown\nSources:\n- [Article](https://example.com/article)\n```',
    'Sources:\nThis paragraph explains the evidence.\n\n## Conclusion\nKeep this conclusion.',
    'Claim [1](https://example.com/article).',
  ]) {
    expect(
      citedResponse(
        { content, additional_kwargs: {} },
        { includeSourceList: false }
      )
    ).toBe(content)
  }
})

test('links the single and grouped caret citations reported in the Spanish answer', () => {
  const content =
    'Quedó el año casi plano.^2,4,7^ Volatilidad alta.^1^ Entrada de largo plazo.^6^'
  const citations = Array.from({ length: 7 }, (_, index) => ({
    url: `https://example.com/source-${index + 1}`,
  }))
  expect(
    citedResponse(response(content, citations), { includeSourceList: false })
  ).toBe(
    'Quedó el año casi plano.[2](<https://example.com/source-2>), [4](<https://example.com/source-4>), [7](<https://example.com/source-7>) Volatilidad alta.[1](<https://example.com/source-1>) Entrada de largo plazo.[6](<https://example.com/source-6>)'
  )
})

test('keeps provider numbering across invalid and duplicate citation entries', () => {
  const result = citedResponse(
    response('Evidence.^1,2,3,4,5^', [
      { url: 'https://example.com/one' },
      { url: 'javascript:alert(1)' },
      { title: 'Missing URL' },
      { url: 'https://example.com/one' },
      { url: 'https://example.com/five' },
    ])
  )
  expect(result).toBe(
    'Evidence.[1](<https://example.com/one>), ^2^, ^3^, [4](<https://example.com/one>), [5](<https://example.com/five>)\n\nSources:\n- [Source 1](<https://example.com/one>)\n- [Source 5](<https://example.com/five>)'
  )
})

test('preserves unknown citations and ordinary Markdown when sources are absent', () => {
  const content =
    'Unknown.^2,4,7^ Ordinary [1] and [link](https://example.com).'
  expect(citedResponse(response(content, []))).toBe(content)
  expect(citedResponse({ content, additional_kwargs: {} })).toBe(content)
})

test.each([
  '`Literal ^1^`',
  '``Literal ` ^1^``',
  '```text\nLiteral ^1^\n```',
  '~~~text\nLiteral ^1^\n~~~',
  '[Literal ^1^](https://example.com/^1^)',
  '\\^1^',
])('preserves citation-like text in Markdown %j', (literal) => {
  expect(
    citedResponse(
      response(`${literal}\n\nClaim.^1^`, [
        { url: 'https://example.com/article' },
      ]),
      { includeSourceList: false }
    )
  ).toBe(`${literal}\n\nClaim.[1](<https://example.com/article>)`)
})
