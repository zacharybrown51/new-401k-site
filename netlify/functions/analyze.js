const API_URL = 'https://api.anthropic.com/v1/messages';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

const EXTRACTION_SYSTEM_PROMPT = `You are a Form 5500 retirement plan filing analyst.

Your job is to extract useful retirement-plan data from a Form 5500 PDF into one valid JSON object.

Rules:
- Return exactly one valid JSON object.
- No markdown fences.
- No commentary.
- No trailing commas.
- If a field is not found, use null.
- Keep arrays concise:
  - investments: include up to 20 of the largest or most clearly identified holdings
  - serviceProviders: include up to 15 clearly identified providers
  - assetAllocation: include clearly stated categories only
  - planFeatures: include only clearly inferable features/codes
- Prefer accuracy over completeness.
- Do not invent values.

Return this exact JSON shape:
{
  "planName": string|null,
  "sponsor": string|null,
  "ein": string|null,
  "planNumber": string|null,
  "planYear": string|null,
  "planType": string|null,
  "filingType": string|null,
  "participants": {
    "beginningOfYear": number|null,
    "activeEndOfYear": number|null,
    "totalEndOfYear": number|null,
    "retired": number|null,
    "separated": number|null,
    "deceased": number|null,
    "withAccountBalances": number|null,
    "terminatedUnvested": number|null
  },
  "financials": {
    "totalAssetsBOY": number|null,
    "totalAssetsEOY": number|null,
    "netAssets": number|null,
    "totalContributions": number|null,
    "employerContributions": number|null,
    "participantContributions": number|null,
    "rollovers": number|null,
    "benefitsPaid": number|null,
    "totalIncome": number|null,
    "totalExpenses": number|null,
    "adminExpenses": number|null,
    "investmentGainLoss": number|null,
    "netIncome": number|null,
    "participantLoans": number|null,
    "employerSecurities": number|null
  },
  "assetAllocation": [{"category": string, "beginningValue": number|null, "endValue": number|null}],
  "investments": [{"name": string, "value": number|null, "type": string|null}],
  "serviceProviders": [{"name": string, "ein": string|null, "role": string|null, "serviceCodes": string|null, "directCompensation": number|null, "indirectCompensation": number|null, "relationship": string|null}],
  "planFeatures": [{"code": string, "description": string}],
  "compliance": {
    "lateContributions": boolean|null,
    "lateContributionAmount": number|null,
    "prohibitedTransactions": boolean|null,
    "loansInDefault": boolean|null,
    "fidelityBond": boolean|null,
    "fidelityBondAmount": number|null,
    "blackoutPeriod": boolean|null,
    "failedToPayBenefits": boolean|null,
    "assetsHeldForInvestment": boolean|null,
    "planTerminating": boolean|null
  },
  "auditor": {"name": string|null, "ein": string|null, "opinionType": string|null},
  "fundingInfo": {"minimumRequired": number|null, "actualContribution": number|null, "fundingShortfall": number|null},
  "notes": string|null
}`;

const CORE_EXTRACTION_PROMPT = `Extract ONLY the core plan data from this Form 5500.
Return exactly one valid JSON object and nothing else.
No markdown.
No explanation.

Use this exact shape:
{
  "planName": string|null,
  "sponsor": string|null,
  "ein": string|null,
  "planNumber": string|null,
  "planYear": string|null,
  "participants": {
    "totalEndOfYear": number|null,
    "withAccountBalances": number|null
  },
  "financials": {
    "totalAssetsEOY": number|null,
    "participantContributions": number|null,
    "employerContributions": number|null
  },
  "serviceProviders": [{"name": string, "role": string|null}],
  "notes": string|null
}`;

const INSIGHT_SYSTEM_PROMPT = `You are an experienced retirement plan advisor reviewing a Form 5500 analysis.

Given structured plan data, produce concise but thoughtful practical feedback in JSON.

Rules:
- Return exactly one valid JSON object.
- No markdown.
- No commentary outside the JSON.
- Be analytical and useful, not hypey.
- Base comments on the data provided. If uncertain, say so briefly.
- Keep each bullet short and practical.

Return this exact shape:
{
  "summary": string|null,
  "strengths": [string],
  "watchItems": [string],
  "opportunities": [string],
  "questionsToAsk": [string],
  "humanTake": string|null,
  "confidence": string|null
}`;

function jsonResponse(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function extractTextFromAnthropicResponse(data) {
  let text = '';
  const blocks = Array.isArray(data?.content) ? data.content : [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  return text.trim();
}

function extractBalancedJSONObject(str) {
  const start = str.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in model response');

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return str.slice(start, i + 1);
      }
    }
  }

  throw new Error('No complete JSON object found in model response');
}

function cleanCandidateJSON(str) {
  return String(str || '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']')
    .trim();
}

function parseMaybeJSON(rawText) {
  const cleanedText = cleanCandidateJSON(rawText);
  const candidate = extractBalancedJSONObject(cleanedText);
  return JSON.parse(candidate);
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const stripped = String(v).replace(/[$,%\s,()]/g, '').trim();
  if (!stripped) return null;
  const num = Number(stripped);
  return Number.isFinite(num) ? num : null;
}

function toBoolOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

function toStringOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function limitArray(arr, max) {
  return Array.isArray(arr) ? arr.slice(0, max) : [];
}

function normalizeParsed(r) {
  const participants = r?.participants || {};
  const financials = r?.financials || {};
  const compliance = r?.compliance || {};
  const auditor = r?.auditor || {};
  const fundingInfo = r?.fundingInfo || {};

  return {
    planName: toStringOrNull(r?.planName),
    sponsor: toStringOrNull(r?.sponsor),
    ein: toStringOrNull(r?.ein)?.replace(/[^\d-]/g, '') || null,
    planNumber: toStringOrNull(r?.planNumber),
    planYear: toStringOrNull(r?.planYear),
    planType: toStringOrNull(r?.planType),
    filingType: toStringOrNull(r?.filingType),
    participants: {
      beginningOfYear: toNumberOrNull(participants.beginningOfYear),
      activeEndOfYear: toNumberOrNull(participants.activeEndOfYear),
      totalEndOfYear: toNumberOrNull(participants.totalEndOfYear),
      retired: toNumberOrNull(participants.retired),
      separated: toNumberOrNull(participants.separated),
      deceased: toNumberOrNull(participants.deceased),
      withAccountBalances: toNumberOrNull(participants.withAccountBalances),
      terminatedUnvested: toNumberOrNull(participants.terminatedUnvested)
    },
    financials: {
      totalAssetsBOY: toNumberOrNull(financials.totalAssetsBOY),
      totalAssetsEOY: toNumberOrNull(financials.totalAssetsEOY),
      netAssets: toNumberOrNull(financials.netAssets),
      totalContributions: toNumberOrNull(financials.totalContributions),
      employerContributions: toNumberOrNull(financials.employerContributions),
      participantContributions: toNumberOrNull(financials.participantContributions),
      rollovers: toNumberOrNull(financials.rollovers),
      benefitsPaid: toNumberOrNull(financials.benefitsPaid),
      totalIncome: toNumberOrNull(financials.totalIncome),
      totalExpenses: toNumberOrNull(financials.totalExpenses),
      adminExpenses: toNumberOrNull(financials.adminExpenses),
      investmentGainLoss: toNumberOrNull(financials.investmentGainLoss),
      netIncome: toNumberOrNull(financials.netIncome),
      participantLoans: toNumberOrNull(financials.participantLoans),
      employerSecurities: toNumberOrNull(financials.employerSecurities)
    },
    assetAllocation: limitArray(r?.assetAllocation, 20).map(x => ({
      category: toStringOrNull(x?.category) || 'Unspecified',
      beginningValue: toNumberOrNull(x?.beginningValue),
      endValue: toNumberOrNull(x?.endValue)
    })),
    investments: limitArray(r?.investments, 20).map(x => ({
      name: toStringOrNull(x?.name) || 'Unnamed investment',
      value: toNumberOrNull(x?.value),
      type: toStringOrNull(x?.type)
    })),
    serviceProviders: limitArray(r?.serviceProviders, 15).map(x => ({
      name: toStringOrNull(x?.name) || 'Unnamed provider',
      ein: toStringOrNull(x?.ein),
      role: toStringOrNull(x?.role),
      serviceCodes: toStringOrNull(x?.serviceCodes),
      directCompensation: toNumberOrNull(x?.directCompensation),
      indirectCompensation: toNumberOrNull(x?.indirectCompensation),
      relationship: toStringOrNull(x?.relationship)
    })),
    planFeatures: limitArray(r?.planFeatures, 20).map(x => ({
      code: toStringOrNull(x?.code) || '',
      description: toStringOrNull(x?.description) || ''
    })).filter(x => x.code || x.description),
    compliance: {
      lateContributions: toBoolOrNull(compliance.lateContributions),
      lateContributionAmount: toNumberOrNull(compliance.lateContributionAmount),
      prohibitedTransactions: toBoolOrNull(compliance.prohibitedTransactions),
      loansInDefault: toBoolOrNull(compliance.loansInDefault),
      fidelityBond: toBoolOrNull(compliance.fidelityBond),
      fidelityBondAmount: toNumberOrNull(compliance.fidelityBondAmount),
      blackoutPeriod: toBoolOrNull(compliance.blackoutPeriod),
      failedToPayBenefits: toBoolOrNull(compliance.failedToPayBenefits),
      assetsHeldForInvestment: toBoolOrNull(compliance.assetsHeldForInvestment),
      planTerminating: toBoolOrNull(compliance.planTerminating)
    },
    auditor: {
      name: toStringOrNull(auditor.name),
      ein: toStringOrNull(auditor.ein),
      opinionType: toStringOrNull(auditor.opinionType)
    },
    fundingInfo: {
      minimumRequired: toNumberOrNull(fundingInfo.minimumRequired),
      actualContribution: toNumberOrNull(fundingInfo.actualContribution),
      fundingShortfall: toNumberOrNull(fundingInfo.fundingShortfall)
    },
    notes: toStringOrNull(r?.notes)
  };
}

function normalizeCoreParsed(r) {
  return normalizeParsed({
    planName: r?.planName ?? null,
    sponsor: r?.sponsor ?? null,
    ein: r?.ein ?? null,
    planNumber: r?.planNumber ?? null,
    planYear: r?.planYear ?? null,
    participants: {
      totalEndOfYear: r?.participants?.totalEndOfYear ?? null,
      withAccountBalances: r?.participants?.withAccountBalances ?? null
    },
    financials: {
      totalAssetsEOY: r?.financials?.totalAssetsEOY ?? null,
      participantContributions: r?.financials?.participantContributions ?? null,
      employerContributions: r?.financials?.employerContributions ?? null
    },
    serviceProviders: Array.isArray(r?.serviceProviders) ? r.serviceProviders : [],
    notes: r?.notes ?? null
  });
}

function normalizeInsights(r) {
  return {
    summary: toStringOrNull(r?.summary),
    strengths: limitArray(r?.strengths, 5).map(x => toStringOrNull(x)).filter(Boolean),
    watchItems: limitArray(r?.watchItems, 5).map(x => toStringOrNull(x)).filter(Boolean),
    opportunities: limitArray(r?.opportunities, 5).map(x => toStringOrNull(x)).filter(Boolean),
    questionsToAsk: limitArray(r?.questionsToAsk, 5).map(x => toStringOrNull(x)).filter(Boolean),
    humanTake: toStringOrNull(r?.humanTake),
    confidence: toStringOrNull(r?.confidence)
  };
}

function looksTruncated(rawText) {
  const t = cleanCandidateJSON(rawText);
  const openBraces = (t.match(/{/g) || []).length;
  const closeBraces = (t.match(/}/g) || []).length;
  return closeBraces < openBraces;
}

async function callAnthropic(payload, apiKey) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });

  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!resp.ok) {
    throw new Error(data?.error?.message || data?.error || text || `Anthropic error ${resp.status}`);
  }

  return data;
}

async function repairJsonWithClaude(rawText, apiKey) {
  const repairPrompt = `Convert the following malformed or noisy model output into exactly one valid JSON object.
Return only JSON.
Do not add commentary.
Preserve information when possible.
If the content is obviously truncated and cannot be repaired confidently, return:
{"_repair_error":"truncated_or_unrepairable","raw_excerpt":"..."}

MODEL OUTPUT TO REPAIR:
${rawText}`;

  const data = await callAnthropic({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: repairPrompt }] }]
  }, apiKey);

  return extractTextFromAnthropicResponse(data);
}

async function parseResponseWithRepair(rawText, apiKey) {
  try {
    return { parsed: parseMaybeJSON(rawText), repaired: false };
  } catch {
    const repairedRaw = await repairJsonWithClaude(rawText, apiKey);
    const repairedParsed = parseMaybeJSON(repairedRaw);
    if (repairedParsed && repairedParsed._repair_error) {
      const err = new Error('The model returned incomplete or unrepairable JSON.');
      err.rawText = rawText;
      throw err;
    }
    return { parsed: repairedParsed, repaired: true, repairedRaw };
  }
}

async function generateInsights(parsed, apiKey, partial) {
  const prompt = `Review this structured Form 5500 plan data and return advisor-style insights in the required JSON format.

Partial extraction: ${partial ? 'yes' : 'no'}

PLAN DATA:
${JSON.stringify(parsed)}`;

  const insightResponse = await callAnthropic({
    model: 'claude-sonnet-4-6',
    max_tokens: 1800,
    temperature: 0.2,
    system: INSIGHT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  }, apiKey);

  const rawText = extractTextFromAnthropicResponse(insightResponse);
  const parsedInsight = await parseResponseWithRepair(rawText, apiKey);
  return normalizeInsights(parsedInsight.parsed);
}

async function extract5500(base64, fileName, apiKey) {
  const corePass = await callAnthropic({
    model: 'claude-sonnet-4-6',
    max_tokens: 1800,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: CORE_EXTRACTION_PROMPT }
      ]
    }]
  }, apiKey);

  const coreRawText = extractTextFromAnthropicResponse(corePass);
  const coreResult = await parseResponseWithRepair(coreRawText, apiKey);
  const coreParsed = normalizeCoreParsed(coreResult.parsed);

  if (!coreParsed.planName && !coreParsed.ein && !coreParsed.financials.totalAssetsEOY) {
    const err = new Error('Core extraction failed.');
    err.rawText = coreRawText;
    throw err;
  }

  const userPrompt = `Analyze this Form 5500 filing and return exactly one valid JSON object using the required schema.
No markdown.
No explanation.
If a field is not present, use null.
Be concise and accurate.`;

  let finalParsed = coreParsed;
  let partial = true;
  let repaired = !!coreResult.repaired;
  let rawText = coreRawText;

  try {
    const fullPass = await callAnthropic({
      model: 'claude-sonnet-4-6',
      max_tokens: 3400,
      temperature: 0,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: userPrompt }
        ]
      }]
    }, apiKey);

    const fullRawText = extractTextFromAnthropicResponse(fullPass);
    const fullResult = await parseResponseWithRepair(fullRawText, apiKey);

    finalParsed = normalizeParsed(fullResult.parsed);
    partial = false;
    repaired = !!fullResult.repaired;
    rawText = fullRawText;
  } catch {
    // Keep reliable core extraction
  }

  let insights = null;
  try {
    insights = await generateInsights(finalParsed, apiKey, partial);
  } catch {
    insights = null;
  }

  return {
    parsed: finalParsed,
    rawText,
    partial,
    repaired,
    insights
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return jsonResponse(405, { ok: false, error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return jsonResponse(500, { ok: false, error: 'Missing ANTHROPIC_API_KEY environment variable in Netlify.' });

  try {
    const body = JSON.parse(event.body || '{}');

    if (body.mode === 'extract_5500') {
      if (!body.base64) return jsonResponse(400, { ok: false, error: 'Missing base64 PDF payload.' });

      try {
        const result = await extract5500(body.base64, body.fileName || null, process.env.ANTHROPIC_API_KEY);
        return jsonResponse(200, {
          ok: true,
          parsed: result.parsed,
          partial: !!result.partial,
          repaired: !!result.repaired,
          insights: result.insights || null
        });
      } catch (err) {
        return jsonResponse(422, {
          ok: false,
          error: err.message || 'Could not extract structured JSON from filing.',
          rawText: typeof err.rawText === 'string' ? err.rawText.slice(0, 4000) : undefined,
          details: (err && err.details) ? err.details : (looksTruncated(err.rawText || '') ? 'Model output appears truncated.' : undefined)
        });
      }
    }

    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    const text = await resp.text();
    return { statusCode: resp.status, headers: CORS_HEADERS, body: text };
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: err && err.message ? err.message : 'Function failed',
      details: err && err.stack ? String(err.stack).slice(0, 2000) : String(err)
    });
  }
};
