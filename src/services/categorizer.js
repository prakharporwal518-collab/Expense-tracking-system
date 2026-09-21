import { guessCategoryByKeyword } from './nlp.js';

/**
 * Multinomial Naive Bayes over the user's OWN history, with Laplace smoothing.
 *
 *   P(category | words) ∝ P(category) * Π P(word | category)
 *
 * Trained on demand from past expenses, so it learns personal habits
 * ("Reliance" might be Groceries for one user and Bills for another).
 * Falls back to keyword matching while history is too thin to be meaningful.
 */
const STOPWORDS = new Set(['the', 'a', 'an', 'at', 'on', 'for', 'to', 'of', 'in', 'and', 'paid', 'via', 'my', 'with', 'from', 'by']);
const MIN_SAMPLES = 8;

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && w.length < 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

export function trainModel(samples) {
  const docCount = new Map();      // category -> number of documents
  const wordCount = new Map();     // category -> Map(word -> count)
  const totalWords = new Map();    // category -> total tokens
  const vocab = new Set();
  let total = 0;

  for (const { text, category } of samples) {
    if (!category) continue;
    const tokens = tokenize(text);
    if (!tokens.length) continue;
    total++;
    docCount.set(category, (docCount.get(category) || 0) + 1);
    if (!wordCount.has(category)) wordCount.set(category, new Map());
    const bag = wordCount.get(category);
    for (const t of tokens) {
      bag.set(t, (bag.get(t) || 0) + 1);
      totalWords.set(category, (totalWords.get(category) || 0) + 1);
      vocab.add(t);
    }
  }
  return { docCount, wordCount, totalWords, vocab, total };
}

export function predict(model, text) {
  const tokens = tokenize(text);
  if (!model || model.total < MIN_SAMPLES || !tokens.length) {
    const fallback = guessCategoryByKeyword(text);
    return fallback
      ? { category: fallback.category, confidence: fallback.confidence, source: 'keywords' }
      : { category: null, confidence: 0, source: 'none' };
  }

  const V = model.vocab.size || 1;
  const scores = [];
  for (const [category, docs] of model.docCount) {
    // Log space: probabilities of many rare words underflow float64 otherwise.
    let score = Math.log(docs / model.total);
    const bag = model.wordCount.get(category) || new Map();
    const denom = (model.totalWords.get(category) || 0) + V;
    for (const t of tokens) score += Math.log(((bag.get(t) || 0) + 1) / denom);
    scores.push({ category, score });
  }
  scores.sort((a, b) => b.score - a.score);

  // Softmax over the top scores gives a usable confidence instead of a raw logprob.
  const max = scores[0].score;
  const exps = scores.map((s) => Math.exp(s.score - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const confidence = sum > 0 ? exps[0] / sum : 0;

  const keyword = guessCategoryByKeyword(text);
  if (keyword && confidence < 0.55) {
    return { category: keyword.category, confidence: keyword.confidence, source: 'keywords' };
  }
  return {
    category: scores[0].category,
    confidence: Number(confidence.toFixed(3)),
    source: 'naive-bayes',
    runnerUp: scores[1] ? scores[1].category : null
  };
}
