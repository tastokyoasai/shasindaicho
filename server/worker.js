/**
 * 写真台帳照合アプリ — 高精度OCR 中継サーバー (Cloudflare Workers)
 *
 * 役割：
 *   ブラウザ(index.html)から画像を受け取り、Gemini API に手書き対応OCRを依頼して、
 *   看板項目(対象1・状況・方向・撮影日・件名・撮影者)を JSON で返す。
 *   Gemini の API キーはこの Worker の環境変数(シークレット)に置くので、
 *   公開している index.html 側にはキーが一切出ない＝盗まれない。
 *
 * 必要な環境変数：
 *   GEMINI_API_KEY … Google AI Studio で発行したキー（シークレットとして設定）
 *   GEMINI_MODEL   … 省略可。使用するモデルを固定する場合に設定。
 *   ALLOW_ORIGIN   … 必須。自分のGitHub Pagesのオリジン（例: https://xxx.github.io）
 */
 
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_BASE64_CHARS = 8 * 1024 * 1024;
const PREF2 = ["SA","SB","SC","SD","SE","SF","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SP","SS","ST","SU","SW","SX","SY","SZ","NR"];
const JOUKYOU = ["掘方完掘","掘方断面","出土状況","検出状況","設定状況","復旧状況","検出","完掘","断面","全景","近景"];
const HOUKOU = ["北西","南西","北東","南東","北","南","東","西"];
 
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!configuredOrigins(env).length) {
      return json({ error: "server: ALLOW_ORIGIN 未設定" }, 500, cors);
    }
 
    // プリフライト(CORS)
    if (request.method === "OPTIONS") {
      if (!originAllowed(request, env)) {
        return json({ error: "origin not allowed" }, 403, cors);
      }
      return new Response(null, { headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405, cors);
    }
    if (!originAllowed(request, env)) {
      return json({ error: "origin not allowed" }, 403, cors);
    }
    if (!env.GEMINI_API_KEY) {
      return json({ error: "server: GEMINI_API_KEY 未設定" }, 500, cors);
    }
 
    // Cloudflare Rate Limiting binding。通常の一括OCRは直列処理なので60回/分で十分余裕がある。
    if (env.OCR_RATE_LIMITER) {
      const origin = request.headers.get("Origin") || "no-origin";
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.OCR_RATE_LIMITER.limit({ key: origin + "|" + ip });
      if (!success) {
        return json({ error: "rate limit" }, 429, { ...cors, "Retry-After": "60" });
      }
    }
 
    const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      return json({ error: "content-type must be application/json" }, 415, cors);
    }
 
    let body;
    try {
      body = await readJsonLimited(request, MAX_REQUEST_BYTES);
    } catch (e) {
      if (e && e.code === "TOO_LARGE") {
        return json({ error: "request too large" }, 413, cors);
      }
      return json({ error: "bad json" }, 400, cors);
    }
 
    const { image, mime = "image/jpeg", hints = {} } = body || {};
    if (typeof image !== "string" || !image) return json({ error: "no image" }, 400, cors);
    if (mime !== "image/jpeg") return json({ error: "mime must be image/jpeg" }, 415, cors);
    if (image.length > MAX_BASE64_CHARS || decodedBase64Bytes(image) > MAX_IMAGE_BYTES) {
      return json({ error: "image too large" }, 413, cors);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image)) {
      return json({ error: "invalid base64 image" }, 400, cors);
    }
 
    // GEMINI_MODEL を設定すればそれを固定使用。未設定なら以下を先頭から試し、
    // 404(未提供)なら次の候補へ切り替える。①安いLite→②前世代Lite→③標準の順。
    const candidates = env.GEMINI_MODEL
      ? [env.GEMINI_MODEL]
      : ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"];
 
    // 公開APIの入力をそのままプロンプトへ入れない。許可済み候補だけを採用する。
    const pref2 = allowedHints(hints.pref2, PREF2).join(" ");
    const joukyou = allowedHints(hints.joukyou, JOUKYOU).join("／");
    const houkou = allowedHints(hints.houkou, HOUKOU).join("／");
 
    const prompt =
`あなたは発掘調査の写真に写る「看板（ホワイトボード）」を読み取る、日本語対応の高精度OCRです。
看板の文字は手書きの場合があります。にじみ・かすれ・光の反射・傾きがあっても丁寧に読み取ってください。
 
【看板のレイアウト】看板は次の枠で構成されています。各枠の「見出し文字」そのもの（例:「対象1」「対象2」「メモ」「方向」「撮影者」「日付」）は値ではないので抽出しないこと。枠の中に手書きで記入された内容だけを抽出すること。
・最上段の枠：遺跡名（＝kenmei）
・中央の枠：「対象1」（＝t1）と「対象2」（＝t2）。1つの枠に「対象1・対象2」が中黒(・)で並ぶ看板と、それぞれ独立した「対象1」枠・「対象2」枠になっている看板がある。いずれも枠の見出しラベルで対応づけること。値は遺構番号コードのことも、漢字などの自由記入のこともある（後述）。
・左下の枠：メモ（＝biko）
・その下の枠：日付（＝date）
・中央下の枠：「◯◯から」の方向（＝houkou）
・撮影者の枠：撮影者名（＝sha）
・右下：QRコード（読み取り不要）
なお「状況（＝joukyou）」は独立した「状況」枠にあることも、対象1の近くに手書きされることもある（例:「遺構検出」「完掘」「断面」）。
 
次の各項目を抽出し、指定のJSON形式で返してください。記入の無い項目・読み取れない項目は必ず空文字 "" にすること。推測や創作で埋めないこと。
 
- t1（対象1）／t2（対象2）：看板中央の「対象1」「対象2」の枠に手書きされた対象。書かれているものを、次の(A)(B)いずれかの方針でそのまま読み取る。記入が無ければ ""（対象2の記入が無ければ t2 は ""）。推測で埋めない。
  (A) 遺構番号コード（「2文字の接頭辞＋番号」または「P＋番号」。例: SI12, SP01, P001）のとき：
      接頭辞は次のいずれかに正規化する（コードとして読むときはこれ以外の接頭辞にしない）: ${pref2} / P。
      【手書きの誤読対策・重要】2文字目のアルファベットは、手書きだと形が似ていて間違えやすい。次の字形ルールで厳密に判定すること：
       ・ほぼ垂直な1本の縦線だけ（上下に短い横棒・セリフが付くことはある）＝ I（アイ）。
       ・縦線の下端から右へ伸びる横線がある場合のみ ＝ L（エル）。その横線が無ければ絶対に L としない。
       ・O（オー）と 0（ゼロ）、S と 5、B と 8 の混同にも注意する。
      候補に SI と SL の両方があるが、日本の発掘調査では SI（住居址）が頻出で SL はごくまれ。曖昧なときは頻度の高い方（SI 等）を優先する。番号のゼロ埋めは不要、読めたまま返す。
  (B) コード形式でない自由記入（漢字・かな・記号などの手書き。例:「試掘坑1」「カマド」「炉」「Aトレンチ」）のとき：
      書かれているとおりの表記でそのまま返す。無理にコード化・英字化・省略をしないこと。上の接頭辞リストにも当てはめない。
  枠の見出し文字そのもの（「対象1」「対象2」）は値ではないので返さない。
- joukyou（状況）：看板に手書きされた「状況」を、書いてあるとおりにそのまま読み取る。下は主な例だが、これに無理に合わせて言い換え・短縮しないこと（例:「遺構検出」を「検出」に縮めない、「掘方完掘」をそのまま返す）。無ければ ""。 主な例： ${joukyou}
- houkou（方向）：「◯◯から」と書かれた撮影方向（「から」は付けない）。方位盤の8方向のいずれか。無ければ ""： ${houkou}
- date（撮影日）：YYYY-MM-DD 形式に正規化。年が書かれていなければ "".
- kenmei（件名／遺跡名）：最上段の枠の内容（市町村名＋遺跡名など）。無ければ "".
- biko（メモ）：メモ枠の内容。無ければ "".
- sha（撮影者）：撮影者の氏名。無ければ "".`;
 
    const payload = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: image } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        response_mime_type: "application/json",
        response_schema: {
          type: "object",
          properties: {
            t1: { type: "string" },
            t2: { type: "string" },
            joukyou: { type: "string" },
            houkou: { type: "string" },
            date: { type: "string" },
            kenmei: { type: "string" },
            biko: { type: "string" },
            sha: { type: "string" },
          },
          required: ["t1", "t2", "joukyou", "houkou", "date", "kenmei", "biko", "sha"],
        },
      },
    };
 
    let r = null, lastErr = "", usedModel = "";
    outer:
    for (const model of candidates) {
      // 2.5/3系・latest系は「思考(thinking)」を切って応答を速くする（thinkingBudget:0）。
      // 対応しないモデル向けに、思考指定なしでの再試行も用意する。
      const canThink = /gemini-(?:2\.5|3)/.test(model) || model.endsWith("-latest");
      const attempts = canThink ? [true, false] : [false];
      const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      for (const noThink of attempts) {
        const gcfg = { ...payload.generationConfig };
        if (noThink) gcfg.thinkingConfig = { thinkingBudget: 0 };
        try {
          r = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, generationConfig: gcfg }),
          });
        } catch (e) {
          return json({ error: "upstream fetch failed", detail: String(e) }, 502, cors);
        }
        if (r.ok) { usedModel = model; break outer; }
        const t = await r.text().catch(() => "");
        lastErr = "gemini " + r.status + " (" + model + (noThink ? " +noThink" : "") + "): " + t.slice(0, 400);
        if (r.status === 404) { r = null; break; }                 // このモデルは無い→次のモデルへ
        if (r.status === 400 && noThink) { r = null; continue; }   // thinkingConfig非対応かも→思考指定なしで再試行
        return json({ error: "gemini " + r.status, model, detail: t.slice(0, 500) }, 502, cors);
      }
    }
    if (!r || !r.ok) {
      return json({ error: "no usable model", detail: lastErr }, 502, cors);
    }
 
    let data;
    try {
      data = await r.json();
    } catch {
      return json({ error: "gemini: 応答がJSONでない" }, 502, cors);
    }
 
    let out = {};
    try {
      const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
      out = JSON.parse(txt);
    } catch {
      out = {};
    }
 
    // 念のため型と余計な空白を整える
    const s = (v) => (typeof v === "string" ? v.trim() : "");
    // 遺構番号コード（英字1〜2＋数字）のときだけ大文字化＋空白除去。
    // 「試掘坑1」などの自由記入は表記を変えずにそのまま返す。
    const normTarget = (v) => {
      const t = s(v);
      const compact = t.replace(/\s+/g, "");
      return /^[A-Za-z]{1,2}\d{1,3}$/.test(compact) ? compact.toUpperCase() : t;
    };
    const result = {
      t1: normTarget(out.t1),
      t2: normTarget(out.t2),
      joukyou: s(out.joukyou),
      houkou: s(out.houkou).replace(/から$/, ""),
      date: s(out.date),
      kenmei: s(out.kenmei),
      biko: s(out.biko),
      sha: s(out.sha),
    };
 
    // 実際に使ったモデル名を返す（開発者ツールの Network → レスポンスヘッダで確認できる）
    return json(result, 200, { ...cors, "X-OCR-Model": usedModel });
  },
};
 
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
 
function configuredOrigins(env) {
  return String(env.ALLOW_ORIGIN || "")
    .split(",")
    .map((v) => v.trim().replace(/\/$/, ""))
    .filter(Boolean);
}
 
function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // CLI等はレート制限で保護
  const allowed = configuredOrigins(env);
  return allowed.includes("*") || allowed.includes(origin.replace(/\/$/, ""));
}
 
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = configuredOrigins(env);
  const allowValue = allowed.includes("*") ? "*" :
    (origin && allowed.includes(origin.replace(/\/$/, "")) ? origin : "");
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "X-OCR-Model",
  };
  if (allowValue) headers["Access-Control-Allow-Origin"] = allowValue;
  if (allowValue !== "*") headers["Vary"] = "Origin";
  return headers;
}
 
async function readJsonLimited(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maxBytes) throw tooLarge();
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
 
function tooLarge() {
  const e = new Error("too large");
  e.code = "TOO_LARGE";
  return e;
}
 
function decodedBase64Bytes(value) {
  const padding = value.endsWith("==") ? 2 : (value.endsWith("=") ? 1 : 0);
  return Math.floor(value.length * 3 / 4) - padding;
}
 
function allowedHints(input, allowed) {
  if (!Array.isArray(input)) return allowed;
  const picked = input.filter((v) => typeof v === "string" && allowed.includes(v));
  return picked.length ? [...new Set(picked)] : allowed;
}
 
