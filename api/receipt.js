/* 매입 사진 자동 입력 (2026-11-17 사장님 요청) — 거래명세서·영수증 사진을 Claude 가 읽어 품목·수량·금액을 돌려준다.
   Vercel 서버 함수. AI 열쇠(ANTHROPIC_API_KEY)는 Vercel 환경변수에만 있고 앱·GitHub 에는 없다.
   아무나 부를 수 없게, 부른 기기가 등록 기기인지 Supabase 에 되묻는다:
     ① 표(ticket) — 앱이 Supabase 의 ai_ticket() 으로 받아 온 1회용 표를 ai_ticket_check() 로 확인 (매장 인터넷으로 열린 기기도 통과)
     ② 기기 열쇠 — 표 기능이 서버에 아직 없으면 x-device-key 로 device_ok() 확인 */
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';

export const config = { maxDuration: 60 };

const SUPA_URL = process.env.SUPABASE_URL || 'https://pmkxwcdoqqjeipqmukzw.supabase.co';
const SUPA_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_EXY0gMpArHtuYp-XkCYLeA_BFSMhfi3';   // 공개용(publishable) 키 — 비밀 아님
const MODEL = process.env.RECEIPT_MODEL || 'claude-opus-5-5';
const CATS = ['대게', '킹크랩', '랍스터', '수산물', '식자재', '주류·음료', '소모품', '기타'];
const UNITS = ['kg', '단', '미', '박스', '개', '봉', '팩', '병', 'L'];
const MEDIA = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_B64 = 4_000_000;   // 약 3MB 사진 (앱이 올리기 전에 줄여서 보낸다)

const SCHEMA = {
  type: 'object',
  properties: {
    is_purchase_doc: { type: 'boolean', description: '거래명세서·영수증·세금계산서·주문 내역처럼 무언가를 산 기록이 맞는지' },
    doc_date: { type: ['string', 'null'], description: '문서의 거래 날짜 YYYY-MM-DD. 안 보이면 null' },
    vendor: { type: ['string', 'null'], description: '판 곳(공급자·가게) 이름. 안 보이면 null' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '품목 이름 — 문서에 적힌 그대로, 규격이 있으면 같이 (예: 깻잎 100g)' },
          qty: { type: ['number', 'null'], description: '수량. 안 보이면 null' },
          unit: { type: ['string', 'null'], enum: [...UNITS, null], description: '단위. 목록에 없거나 안 보이면 null' },
          amount: { type: 'integer', description: '그 품목의 금액(원) — 단가가 아니라 수량을 곱한 금액' },
          cat: { type: 'string', enum: CATS },
          unsure: { type: 'boolean', description: '글씨가 흐리거나 잘려서 이름·금액 중 하나라도 확신이 없으면 true' },
        },
        required: ['name', 'qty', 'unit', 'amount', 'cat', 'unsure'],
        additionalProperties: false,
      },
    },
    total: { type: ['integer', 'null'], description: '문서에 적힌 최종 합계(원, 부가세 포함 금액이 있으면 그것). 안 보이면 null' },
    tax: { type: ['integer', 'null'], description: '품목 금액과 따로 적힌 부가세 합계(원). 없거나 품목 금액에 이미 들어 있으면 null' },
    notes: { type: 'array', items: { type: 'string' }, description: '사람이 확인해야 할 점을 한국어 한 줄씩 (잘린 부분, 못 읽은 줄, 합계 불일치 등). 없으면 빈 배열' },
  },
  required: ['is_purchase_doc', 'doc_date', 'vendor', 'items', 'total', 'tax', 'notes'],
  additionalProperties: false,
};

const SYSTEM = `너는 한국의 대게·킹크랩 식당에서 매입 기록을 돕는다. 직원이 거래명세서·영수증·세금계산서·배달 주문 내역을 휴대폰으로 찍어 올리면, 사진에 보이는 내용을 그대로 옮겨 적는다.

이 결과는 직원이 한 번 훑어본 뒤 그대로 장부에 들어간다. 그래서 틀린 숫자를 그럴듯하게 채우는 것이 가장 나쁜 결과다. 읽을 수 없는 글자는 추측해서 채우지 말고, 그 줄에 unsure 를 켜고 notes 에 어느 줄이 왜 불확실한지 적는다.

옮겨 적는 방법:
- 품목은 문서의 줄 하나가 items 하나다. 합계·소계·부가세·할인·배달비 줄은 품목이 아니다(배달비·수수료처럼 실제로 낸 돈이면 "배달비" 같은 이름의 품목으로 넣고 분류는 기타).
- amount 는 그 줄의 금액이다. 문서에 단가와 금액이 따로 있으면 금액 칸을 쓴다. 금액 칸이 없고 단가와 수량만 있으면 곱해서 넣고 notes 에 그렇게 계산했다고 적는다.
- 부가세가 품목 금액과 별도로 한 줄에 적혀 있으면 tax 에 넣는다. 품목 금액이 이미 부가세 포함이면 tax 는 null 이다.
- 날짜는 거래일이다. 연도가 두 자리거나 없으면 오늘({TODAY}) 기준으로 가장 가까운 과거 날짜로 본다.
- 분류(cat): 대게·킹크랩·랍스터는 살아 있거나 냉동인 그 갑각류 자체일 때만. 그 밖의 생선·조개·새우 등은 수산물, 채소·양념·쌀·고기 등은 식자재, 술·음료·생수는 주류·음료, 장갑·포장 용기·세제·휴지 등은 소모품, 나머지는 기타.
- 사진이 매입 문서가 아니면 is_purchase_doc 을 false 로 하고 items 는 비운 채 notes 에 무엇이 찍혔는지 한 줄 적는다.`;

const send = (res, code, body) => { res.status(code).setHeader('Cache-Control', 'no-store'); res.json(body); };

/* 부른 기기가 매장 기록을 볼 수 있는 기기인지 */
async function allowed(req, ticket) {
  const auth = req.headers.authorization || '';
  if (!/^Bearer .{20,}/.test(auth)) return { ok: false, why: '서버에 연결된 뒤에 다시 해 주세요.' };
  const base = { apikey: SUPA_KEY, Authorization: auth, 'Content-Type': 'application/json' };
  if (ticket) {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/ai_ticket_check`, { method: 'POST', headers: base, body: JSON.stringify({ p_ticket: String(ticket).slice(0, 80) }) });
    if (r.ok && (await r.json()) === true) return { ok: true };
    return { ok: false, why: '확인 표가 만료됐습니다. 다시 눌러 주세요.' };
  }
  const dk = String(req.headers['x-device-key'] || '');
  if (/^[a-f0-9]{48}$/.test(dk)) {
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/device_ok`, { method: 'POST', headers: { ...base, 'x-device-key': dk }, body: '{}' });
    if (r.ok && (await r.json()) === true) return { ok: true };
  }
  return { ok: false, why: '등록된 기기에서만 쓸 수 있습니다.' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST 만 받습니다.' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { image, media_type: mediaType, ticket, today } = body;
  if (typeof image !== 'string' || !image || !MEDIA.includes(mediaType)) return send(res, 400, { error: '사진을 읽지 못했습니다. JPG·PNG 사진으로 다시 올려 주세요.' });
  if (image.length > MAX_B64) return send(res, 413, { error: '사진이 너무 큽니다. 다시 찍거나 잘라서 올려 주세요.' });

  let gate;
  try { gate = await allowed(req, ticket); } catch (e) { return send(res, 502, { error: '기기 확인에 실패했습니다. 잠시 뒤 다시 해 주세요.' }); }
  if (!gate.ok) return send(res, 403, { error: gate.why });

  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'AI 열쇠가 아직 설정되지 않았습니다. 사장님이 Vercel 환경변수 ANTHROPIC_API_KEY 를 넣으면 바로 됩니다.', code: 'no_key' });

  const day = /^\d{4}-\d{2}-\d{2}$/.test(today || '') ? today : new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const client = new Anthropic();
  const withFallback = /^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/.test(MODEL);   // 정책상 거절되면 다른 모델로 한 번 더 — 지원하는 모델에서만
  try {
    const msg = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      system: SYSTEM.replace('{TODAY}', day),
      output_config: { effort: 'medium', format: jsonSchemaOutputFormat(SCHEMA) },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
        { type: 'text', text: '이 사진의 매입 내용을 옮겨 적어 주세요.' },
      ] }],
    });
    if (msg.stop_reason === 'refusal') return send(res, 422, { error: '이 사진은 읽을 수 없다고 판단했습니다. 다른 사진으로 해 보세요.' });
    if (msg.stop_reason === 'max_tokens' || !msg.parsed_output) return send(res, 502, { error: '사진 내용이 너무 길어 끝까지 읽지 못했습니다. 나눠서 찍어 올려 주세요.' });
    return send(res, 200, { result: msg.parsed_output, model: msg.model, usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens } });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return send(res, 503, { error: 'AI 열쇠가 맞지 않습니다. 사장님이 Vercel 환경변수 ANTHROPIC_API_KEY 를 확인해 주세요.', code: 'bad_key' });
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: '지금 요청이 몰렸습니다. 1분 뒤 다시 해 주세요.' });
    if (e instanceof Anthropic.APIError) return send(res, 502, { error: `AI 서버 오류 (${e.status || '연결'}). 잠시 뒤 다시 해 주세요.`, detail: String(e.message || '').slice(0, 200) });
    return send(res, 500, { error: '알 수 없는 오류로 읽지 못했습니다.', detail: String((e && e.message) || e).slice(0, 200) });
  }
}
