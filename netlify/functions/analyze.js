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
  - investments: include up to 25 of the largest or most clearly identified holdings
  - serviceProviders: include up to 20 clearly identified providers
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
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
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
  try {
    data = JSON.parse(text);
  } catch {}

  if (!resp.ok) {
    throw new Error(data?.error?.message || data?.error || text || `Anthropic error ${resp.status}`);
  }

  return data;
}

async function repairJsonWithClaude(rawText, apiKey) {
  const repairPrompt = `Convert the following malformed or noisy model output into exactly one valid JSON object.
Return only JSON.
Do not add commentary.

MODEL OUTPUT TO REPAIR:
${rawText}`;

  const data = await callAnthropic({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: repairPrompt }] }]
  }, apiKey);

  return extractTextFromAnthropicResponse(data);
}

async function extract5500(base64, fileName, apiKey) {
  const userPrompt = `Analyze this Form 5500 filing and return exactly one valid JSON object using the required schema.`;

  const firstPass = await callAnthropic({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
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

  const rawText = extractTextFromAnthropicResponse(firstPass);

  try {
    const parsed = parseMaybeJSON(rawText);
    return { parsed, rawText, repaired: false };
  } catch {
    const repairedRaw = await repairJsonWithClaude(rawText, apiKey);
    const repairedParsed = parseMaybeJSON(repairedRaw);
    return { parsed: repairedParsed, rawText, repaired: true };
  }
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const body = JSON.parse(event.body || '{}');

    const result = await extract5500(body.base64, body.fileName, process.env.ANTHROPIC_API_KEY);

    return jsonResponse(200, {
      ok: true,
      parsed: result.parsed,
      repaired: result.repaired
    });

  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      error: err.message
    });
  }
};
