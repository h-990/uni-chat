/**
 * S-Expression Parser and Formatter for DeepSeek & AI Automator
 * Formats prompts requesting S-expression structured outputs and extracts reply-to sequences.
 */

/**
 * Builds the instruction footer asking the AI to format in S-expression
 * @param {number|null} defaultReplyToSeq
 * @param {string} aiUsername
 * @returns {string}
 */
export function getSExprInstruction(defaultReplyToSeq = null, aiUsername = 'deepseek') {
  const exampleSeq = defaultReplyToSeq || 1;
  return [
    `[Instructions for @${aiUsername}]:`,
    `Format your response strictly as an S-expression:`,
    `(:reply-to ${exampleSeq} :body "Your response text here...")`,
    `- The :reply-to parameter MUST be the integer sequence number (#seq) of the message you are directly replying to.`,
    `- The :body parameter contains your actual message to the room.`,
    `- You do NOT have to answer briefly or keep answers short; provide thorough, high-quality, and helpful answers as needed.`
  ].join('\n');
}

/**
 * Parses an S-expression response from the AI
 * Supported formats:
 *   (:reply-to 42 :body "...")
 *   (ai-reply :reply-to 42 :body "...")
 *   ```lisp (:reply-to 42 :body "...") ```
 *   Or raw text fallback
 *
 * @param {string} rawText
 * @param {number|null} fallbackSeq
 * @returns {{ replyToSeq: number|null, body: string }}
 */
export function parseAIResponse(rawText, fallbackSeq = null) {
  if (!rawText || typeof rawText !== 'string') {
    return { replyToSeq: fallbackSeq, body: '' };
  }

  const trimmed = rawText.trim();

  // Pattern 1: Standard S-expression with :reply-to and :body
  // Matches (:reply-to N :body "...") or (ai-reply :reply-to N :body "...")
  const sexprRegex = /\(\s*(?:ai-reply\s+)?(?::reply-to\s+(\d+)\s+)?(?::body\s+)?"([\s\S]*?)"\s*\)\s*$/;
  const match = trimmed.match(sexprRegex);
  if (match) {
    const seq = match[1] ? parseInt(match[1], 10) : fallbackSeq;
    const body = unescapeSExprString(match[2]);
    return {
      replyToSeq: isNaN(seq) ? fallbackSeq : seq,
      body: body.trim()
    };
  }

  // Pattern 2: Relaxed extraction of :reply-to and :body within any wrapper
  const replyToMatch = trimmed.match(/:reply-to\s+(\d+)/i);
  const bodyMatch = trimmed.match(/:body\s+"([\s\S]*?)"(?:\s*\)|\s*$)/i);

  if (bodyMatch) {
    const seq = replyToMatch ? parseInt(replyToMatch[1], 10) : fallbackSeq;
    return {
      replyToSeq: isNaN(seq) ? fallbackSeq : seq,
      body: unescapeSExprString(bodyMatch[1]).trim()
    };
  }

  // Pattern 3: Code block extraction
  const codeBlockMatch = trimmed.match(/```(?:lisp|scheme|sexpr)?\s*\(\s*(?:ai-reply\s+)?(?::reply-to\s+(\d+)\s+)?(?::body\s+)?"([\s\S]*?)"\s*\)\s*```/i);
  if (codeBlockMatch) {
    const seq = codeBlockMatch[1] ? parseInt(codeBlockMatch[1], 10) : fallbackSeq;
    return {
      replyToSeq: isNaN(seq) ? fallbackSeq : seq,
      body: unescapeSExprString(codeBlockMatch[2]).trim()
    };
  }

  // Fallback: The AI returned standard markdown or raw text without S-expression wrapper
  // Extract reply-to number if mentioned casually (e.g. "Replying to #42: ...")
  const casualReplyMatch = trimmed.match(/(?:replying\s+to|reply\s+to)\s+#?(\d+)/i);
  const extractedSeq = casualReplyMatch ? parseInt(casualReplyMatch[1], 10) : fallbackSeq;

  // Clean any stray wrapper artifacts
  let cleanBody = trimmed;
  if (cleanBody.startsWith('(:body "') && cleanBody.endsWith('")')) {
    cleanBody = cleanBody.slice(8, -2);
  }

  return {
    replyToSeq: isNaN(extractedSeq) ? fallbackSeq : extractedSeq,
    body: unescapeSExprString(cleanBody).trim()
  };
}

function unescapeSExprString(str) {
  if (!str) return '';
  return str
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

