// ============================================================
// STEP2-D-3-C-2: Google Routes API 実通信（Backend専用モジュール）
// 【重要】このモジュールはORD本体の業務ロジック（checkout/dispatch-candidates/
// pricingRules.ts/DB保存）のどこからも呼び出されていない（STEP2-D-3-C-2時点）。
// GOOGLE_MAPS_API_KEY未設定の環境では、下記の実通信コードには一切到達せず、
// 必ずNOT_ATTEMPTEDで即座に返る設計を維持している。
//
// このファイルはindex.tsから独立した単一責務モジュールとし、既存の
// webhookSecurity.ts / webhookEvents.ts / priceCatalog.ts / pricingRules.ts と
// 同じ設計思想（index.tsへ処理を集約しない）を踏襲する。
// pricingRules.tsにはGoogle Maps関連の処理を一切持ち込まない（既存方針を維持）。
//
// 使用API：Google Routes API（Legacy Distance Matrix APIは使用しない）
//   - restaurant → customer：Compute Routes（1経路のみ）
//     POST https://routes.googleapis.com/directions/v2:computeRoutes
//   - driver base → restaurant：Compute Route Matrix（複数候補の一括比較）
//     POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix
// Travel Modeは常にDRIVE固定（ORDは車配送のみ）。
//
// 新しい外部ライブラリは追加していない。Node.js標準のfetch/AbortController
// （Node 18+で利用可能）でGoogle Routes APIのRESTエンドポイントを直接呼び出す。
// ============================================================

// Backend専用の環境変数。index.htmlやブラウザ側JavaScriptには絶対に渡さないこと。
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// 座標が設定されていない場合、AREA_COORDSやarea文字列を代替として使うことは禁止
// （既存のAREA_COORDSは/api/map/overviewの概算表示専用であり、料金計算には一切使わない）。
export interface LatLng {
  readonly latitude: number;
  readonly longitude: number;
}

// ============================================================
// 【Phase 1.2基盤】Place ID存在確認（Google回答待ちの「Place Details表示」機能とは無関係）。
// fields=idのみを指定したPlace Details (New)呼び出しは、Google公式料金表上
// 常に無償（Places API Place Details Essentials (IDs Only) / Places Details - ID Refresh SKU、
// Free Usage Cap Unlimited）である。ここでは施設名・住所などの表示用データは一切取得・
// 返却しない。あくまで「保存済みPlace IDが現在Googleで解決できるか」だけを確認する。
// 【重要】VALID＝Place IDが解決できることの確認であり、施設が営業中であることの
// 保証ではない（vFinal確定事項）。
// ============================================================
export type PlaceIdCheckStatus = 'VALID' | 'NEEDS_CHECK' | 'UNKNOWN';

// ============================================================
// 【Phase B・2026-09-25社長承認】顧客向けGoogle施設検索（Autocomplete New）とPlace Details
// プレビュー取得。いずれもGoogle由来の施設名・住所をDBへ保存する処理は一切含まない
// （呼び出し側がその場限りの表示にのみ使うことを前提とする）。
// ============================================================

export interface AutocompleteSuggestion {
  placeId: string;
  text: string;
}

// Autocomplete (New)。sessionTokenは呼び出し側（クライアント）が生成したv4 UUIDをそのまま
// 中継するだけで、DBへの保存は行わない。includedPrimaryTypes等の絞り込みは今回意図的に
// 指定しない（villa/hotel/resort/condominium/住所等、幅広い入力に対応するため。
// 社長指示：「ホテルだけに限定しない」）。
export async function searchAutocomplete(
  input: string,
  sessionToken: string,
  apiKey: string = GOOGLE_MAPS_API_KEY
): Promise<{ status: 'SUCCESS' | 'API_ERROR' | 'NOT_ATTEMPTED'; suggestions: AutocompleteSuggestion[] }> {
  if (!isGoogleMapsConfigured(apiKey)) {
    return { status: 'NOT_ATTEMPTED', suggestions: [] };
  }
  if (!input || !sessionToken) {
    return { status: 'API_ERROR', suggestions: [] };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        // 必要最小限のフィールドのみ（ワイルドカード禁止、既存方針を踏襲）。
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text',
      },
      body: JSON.stringify({ input, sessionToken, regionCode: 'JP' }),
      signal: controller.signal,
    });
    if (!res.ok) return { status: 'API_ERROR', suggestions: [] };
    const json = await res.json().catch(() => null);
    const rawSuggestions: any[] = Array.isArray(json?.suggestions) ? json.suggestions : [];
    const suggestions: AutocompleteSuggestion[] = rawSuggestions
      .map(s => s?.placePrediction)
      .filter((p: any) => p && typeof p.placeId === 'string' && typeof p.text?.text === 'string')
      .map((p: any) => ({ placeId: p.placeId, text: p.text.text }));
    return { status: 'SUCCESS', suggestions };
  } catch {
    return { status: 'API_ERROR', suggestions: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export interface PlaceDetailsPreview {
  placeId: string;
  name: string;
  address: string;
}

// Place Details (New)。sessionTokenを付与してAutocompleteセッションを完結させる。
// 【重要】ここで取得したname/address/locationはDBへ保存しない（preview表示専用、呼び出し側の責務）。
// displayNameを含めるためProティア課金になる（2026-09-25時点の設計判断：候補一覧の
// Autocomplete text由来の名称ではなく、確認画面では正確性を優先しPlace Details由来の
// displayNameを都度取得する。コスト最適化のため候補表示のtextを再利用する代替案もあるが、
// 顧客の最終確認画面での正確性を優先した。社長確認事項として報告する）。
export async function fetchPlaceDetailsForPreview(
  placeId: string,
  sessionToken: string,
  apiKey: string = GOOGLE_MAPS_API_KEY
): Promise<{ status: 'SUCCESS' | 'NOT_FOUND' | 'INVALID_REQUEST' | 'API_ERROR' | 'NOT_ATTEMPTED'; result: PlaceDetailsPreview | null }> {
  if (!isGoogleMapsConfigured(apiKey)) {
    return { status: 'NOT_ATTEMPTED', result: null };
  }
  if (!placeId) {
    return { status: 'INVALID_REQUEST', result: null };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}&key=${apiKey}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Goog-FieldMask': 'id,displayName,formattedAddress' },
      signal: controller.signal,
    });
    if (res.status === 404) return { status: 'NOT_FOUND', result: null };
    if (res.status === 400) return { status: 'INVALID_REQUEST', result: null };
    if (!res.ok) return { status: 'API_ERROR', result: null };
    const json = await res.json().catch(() => null);
    const name = json?.displayName?.text;
    const address = json?.formattedAddress;
    if (typeof name !== 'string' || typeof address !== 'string') {
      return { status: 'API_ERROR', result: null };
    }
    return { status: 'SUCCESS', result: { placeId, name, address } };
  } catch {
    return { status: 'API_ERROR', result: null };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkPlaceIdExists(
  placeId: string,
  apiKey: string = GOOGLE_MAPS_API_KEY
): Promise<PlaceIdCheckStatus> {
  if (!isGoogleMapsConfigured(apiKey) || !placeId) {
    // APIキー未設定・Place ID未指定はいずれも「確認できなかった」として扱い、
    // 施設側の問題であるかのようなNEEDS_CHECKにはしない。
    return 'UNKNOWN';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?fields=id&key=${apiKey}`;
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (res.ok) return 'VALID';
    // NOT_FOUND(404)＝obsoleteなPlace ID、INVALID_REQUEST(400)＝不正なPlace ID文字列。
    // いずれも「この施設情報の要確認」として扱う（Google公式Place ID Guideの定義に基づく）。
    if (res.status === 404 || res.status === 400) return 'NEEDS_CHECK';
    // それ以外（5xx等）はGoogle側の一時的な障害の可能性が高く、施設固有の問題とは
    // 区別してUNKNOWN（判定保留）とする。
    return 'UNKNOWN';
  } catch {
    // タイムアウト・ネットワークエラー等も施設固有の問題ではないためUNKNOWNとする。
    return 'UNKNOWN';
  } finally {
    clearTimeout(timeout);
  }
}

export type RouteLookupStatus = 'SUCCESS' | 'API_ERROR' | 'NO_ROUTE' | 'INVALID_LOCATION' | 'NOT_ATTEMPTED';

export interface RouteLookupResult {
  status: RouteLookupStatus;
  // status !== 'SUCCESS' の場合、両方とも必ずnull（推測値を返さない）。
  durationMinutes: number | null;
  distanceKm: number | null;
}

// APIキーが設定されているか（Backend側の起動時設定確認用）。
// 引数を渡した場合はその値で判定する（テストで実環境変数に依存せず検証できるようにするため）。
export function isGoogleMapsConfigured(apiKey: string | undefined = GOOGLE_MAPS_API_KEY): boolean {
  return typeof apiKey === 'string' && apiKey.length > 0;
}

// 緯度経度が数値として妥当な範囲かを検証する。null/undefined/NaN/Infinity/範囲外は不正とする。
// stores.latitude等がNULL（未確定）の場合もこの関数でfalseになる。
export function isValidLatLng(point: LatLng | null | undefined): point is LatLng {
  if (!point) return false;
  const { latitude, longitude } = point;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) return false;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) return false;
  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;
  return true;
}

// ============================================================
// 配送時間帯設定（STEP2-D-3-C-1で新設）
// 【重要】「顧客表示用の時間帯ラベル」と「Google MapsのdepartureTimeに使う内部基準時刻」を
// 別々の設定値として分離する。同じ文字列をハードコードして一体化しない
// （将来、内部基準時刻だけを調整できるようにするため。例：18:00-19:00の基準時刻を
// 18:00→18:15に変更しても、顧客表示ラベルは変わらない）。
// 今回はUIを変更しないため、この設定はBackend内部でのみ使用する。
// ============================================================
export interface DeliveryTimeSlot {
  readonly id: string;
  readonly label: string; // 顧客表示用（例:'18:00-19:00'）。UIへの実際の表示は別STEP。
  readonly mapsDepartureTime: string; // 'HH:mm'形式。Google MapsのdepartureTime算出に使う内部基準時刻。
}

export const DELIVERY_TIME_SLOTS: readonly DeliveryTimeSlot[] = [
  { id: 'SLOT_18_19', label: '18:00-19:00', mapsDepartureTime: '18:00' },
  { id: 'SLOT_19_20', label: '19:00-20:00', mapsDepartureTime: '19:00' },
  { id: 'SLOT_20_21', label: '20:00-21:00', mapsDepartureTime: '20:00' },
];

export function getDeliveryTimeSlotById(slotId: string): DeliveryTimeSlot | undefined {
  return DELIVERY_TIME_SLOTS.find(s => s.id === slotId);
}

// 指定した配送時間帯の「Google MapsのdepartureTimeに使う内部基準時刻」を、
// 実際のDateオブジェクトへ変換する。注文時刻（例:14:30）をdepartureTimeとして
// 使わないための専用ロジック（安易に「今」を使う実装を避ける）。
// baseDateを省略した場合は「今日」のその時刻になる。配送予定日が別途決まる場合は
// 呼び出し側がbaseDateにその日付を渡すこと。
export function resolveDepartureTimeForSlot(slotId: string, baseDate: Date = new Date()): Date {
  const slot = getDeliveryTimeSlotById(slotId);
  if (!slot) {
    throw new Error(`未知の配送時間帯IDです: ${slotId}`);
  }
  const [hoursStr, minutesStr] = slot.mapsDepartureTime.split(':');
  const hours = Number(hoursStr);
  const minutes = Number(minutesStr);
  const result = new Date(baseDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

// ============================================================
// Route取得関数の内部実装（STEP2-D-3-C-2で実装）
// 設定確認・座標検証は呼び出し側（computeRestaurantToCustomerRoute等）で完結させ、
// ここでは「有効なAPIキー・妥当な座標が揃っている」場合のみ実行される前提とする。
// ============================================================

const ROUTES_COMPUTE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const ROUTES_COMPUTE_ROUTE_MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

// fetchが無期限に待機しないための上限（ミリ秒）。
const REQUEST_TIMEOUT_MS = 8000;
// 429/5xx/timeout等の一時的エラーに対する有限リトライ回数（無限リトライ禁止）。
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300; // 指数バックオフの基準値（300ms, 600ms, ...）

// Route Matrixは1つの終点(restaurant)に対する起点(driver base)の件数を現実的な範囲に制限する。
// Google Routes APIのComputeRouteMatrixは組み合わせ数(起点×終点)に上限があり、
// TRAFFIC_AWARE等の設定によって上限が変動するため、ORD側でも余裕を持った上限を明示しておく。
// 超過した場合は「一部だけ推測で計算する」ことを避けるため、呼び出し側の設計ミスとして例外にする。
export const MAX_ROUTE_MATRIX_ORIGINS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 429 / 5xx / タイムアウト（AbortError）のみリトライ対象とする。
// 400系（不正リクエスト・認証エラー等）は再試行しても結果が変わらないためリトライしない。
function isRetryableStatus(httpStatus: number | null): boolean {
  if (httpStatus === null) return true; // タイムアウト・ネットワーク断等（HTTPステータスなし）
  if (httpStatus === 429) return true;
  if (httpStatus >= 500 && httpStatus < 600) return true;
  return false;
}

interface RawFetchResult {
  ok: boolean;
  httpStatus: number | null; // タイムアウト等でレスポンス自体を得られない場合はnull
  body: any;
}

// タイムアウト・有限リトライ・指数バックオフを備えた内部fetchラッパー。
// 【重要】無限リトライは行わない（MAX_RETRIES回で必ず終了する）。
async function fetchGoogleRoutesApi(url: string, fieldMask: string, body: unknown): Promise<RawFetchResult> {
  let lastResult: RawFetchResult = { ok: false, httpStatus: null, body: null };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // APIキーはヘッダーでのみ送信し、URLクエリ等には含めない（ログ等への露出を避けるため）。
          'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      lastResult = { ok: res.ok, httpStatus: res.status, body: json };
      if (res.ok || !isRetryableStatus(res.status)) {
        return lastResult;
      }
    } catch (e) {
      // タイムアウト(AbortError)またはネットワークエラー。リトライ対象として扱う。
      lastResult = { ok: false, httpStatus: null, body: null };
    } finally {
      clearTimeout(timeoutId);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }
  return lastResult;
}

// Google Duration型（例:"1234s"）を分単位の数値へ変換する。
// 【重要】丸め処理は行わない（社長承認、2026-09-20）。ドライバー報酬の時間帯区分判定
// （DRIVER_REWARD、30:00/50:00/60:00等の秒単位境界）が実測値をそのまま使う設計のため、
// ここで四捨五入すると本来の区分と異なる金額になってしまう（例:30分01秒が30分ちょうどに
// 丸められ、近距離区分の金額になってしまう）。呼び出し側で丸めが必要な用途があれば、
// その時点で個別に丸めること。
function parseDurationSecondsToMinutes(durationStr: unknown): number | null {
  if (typeof durationStr !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(durationStr);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) return null;
  return seconds / 60;
}

function metersToKm(meters: unknown): number | null {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return null;
  return Math.round((meters / 1000) * 100) / 100; // 小数点2桁に丸める
}

function toWaypoint(point: LatLng) {
  return { location: { latLng: { latitude: point.latitude, longitude: point.longitude } } };
}

// 【Place ID→Routes接続・社長承認】Google Routes APIのWaypointは、location/placeId/address/
// navigationPointTokenが相互排他的なフィールドとして同じ階層に定義されている（Google公式
// リファレンス確認済み）。destination側でPlace IDが確定している場合に使用する。
function toPlaceIdWaypoint(placeId: string) {
  return { placeId };
}

// 実際のGoogle Routes API呼び出し（Compute Routes）。restaurant→customerの1経路のみ。
// 【2026-09-25・社長承認・staticDuration切替】ORDの配送料・最低注文額判定は「加盟店→配送先の
// 標準的な車移動時間」を基準とする方針であり、リアルタイム交通状況で料金区分を変動させない。
// そのため料金判定に使う値をroute.duration（TRAFFIC_AWARE_OPTIMAL時は交通状況を考慮した予測値）
// からroute.staticDuration（交通状況を考慮しない値）へ変更する。routingPreferenceは
// TRAFFIC_AWARE_OPTIMALのまま維持（社長指示）。
//
// departureTime引数は、既存呼び出し元(resolveRestaurantToCustomerPricing等)のAPI互換性を
// 保つため関数シグネチャ上は残すが、Googleへの実際の送信は行わない。理由：
// (1) staticDurationはdepartureTimeの値に依存しないことを実測で確認済み（同一区間で複数の
//     未来時刻を指定してもstaticDurationは常に同一値）
// (2) departureTimeを送信する場合はGoogle仕様上「未来の時刻」でなければならず
//     （DRIVEモードで過去時刻はエラー）、new Date()をそのまま渡すとネットワーク遅延により
//     Google到達時点で過去時刻扱いとなり400 INVALID_ARGUMENTになる不具合が実際に発生していた
// (3) departureTimeを省略した場合はGoogle側がリクエスト受信時刻を既定値として扱うため、
//     この不具合自体が発生しなくなることを実測で確認済み（HTTP 200成功）
// 「Google Maps一般向け画面の表示時間とstaticDurationが完全に同一」とは断定しない。ORDでは
// 「交通状況を考慮しないGoogle RoutesのstaticDurationを、加盟店→配送先の標準的な車移動時間
// として料金判定に使用する」という独自定義として扱う。
// 【Place ID→Routes接続・社長承認】destinationPlaceIdは末尾の任意引数として追加する
// （既存呼び出し元のシグネチャ・座標方式を一切変更しない）。指定があればPlace ID方式、
// なければ従来どおり destination（LatLng）を使用する。origin（加盟店）は常にLatLngのまま
// （社長指示：出発地点は座標方式を維持する）。
async function callComputeRoutes(
  origin: LatLng,
  destination: LatLng | null,
  _departureTime: Date,
  destinationPlaceId?: string | null
): Promise<RouteLookupResult> {
  const destinationWaypoint = destinationPlaceId
    ? toPlaceIdWaypoint(destinationPlaceId)
    : destination
      ? toWaypoint(destination)
      : null;
  if (!destinationWaypoint) {
    // 呼び出し側(computeRestaurantToCustomerRoute)で既に検証済みのはずだが、
    // 念のためここでも推測値を作らず安全側に倒す。
    return { status: 'INVALID_LOCATION', durationMinutes: null, distanceKm: null };
  }
  // routes.durationは将来の交通状況参考値としての利用可能性を残すため取得のみ行い、
  // 現時点ではRouteLookupResultには含めない（API/DBを不必要に拡張しない、社長指示）。
  const fieldMask = 'routes.duration,routes.staticDuration,routes.distanceMeters';
  const body = {
    origin: toWaypoint(origin),
    destination: destinationWaypoint,
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE_OPTIMAL',
    // departureTimeは意図的に送信しない（上記コメント参照）。
  };

  const result = await fetchGoogleRoutesApi(ROUTES_COMPUTE_ROUTES_URL, fieldMask, body);
  if (!result.ok) {
    return { status: 'API_ERROR', durationMinutes: null, distanceKm: null };
  }
  const routes = result.body?.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    // HTTP自体は成功だが経路が見つからない場合（Google仕様上、空配列で返るケースがある）
    return { status: 'NO_ROUTE', durationMinutes: null, distanceKm: null };
  }
  const route = routes[0];
  // 料金判定に使うのはstaticDuration（交通状況を考慮しない標準的な移動時間）。
  const durationMinutes = parseDurationSecondsToMinutes(route?.staticDuration);
  const distanceKm = metersToKm(route?.distanceMeters);
  if (durationMinutes === null || distanceKm === null) {
    // レスポンス形状が想定と異なる場合も推測値を作らずエラー扱いにする。
    return { status: 'API_ERROR', durationMinutes: null, distanceKm: null };
  }
  return { status: 'SUCCESS', durationMinutes, distanceKm };
}

// 実際のGoogle Routes API呼び出し（Compute Route Matrix）。driver base→restaurantの複数候補比較。
async function callComputeRouteMatrix(
  origins: LatLng[],
  destination: LatLng,
  departureTime: Date
): Promise<RouteLookupResult[]> {
  if (origins.length > MAX_ROUTE_MATRIX_ORIGINS) {
    // 候補数が想定を超える場合は一部だけ推測で処理せず、呼び出し側の設計を見直すべき異常として扱う。
    throw new Error(
      `driver候補数(${origins.length})がMAX_ROUTE_MATRIX_ORIGINS(${MAX_ROUTE_MATRIX_ORIGINS})を超えています`
    );
  }

  const fieldMask = 'originIndex,destinationIndex,status,distanceMeters,duration'; // 必要最小限
  const body = {
    origins: origins.map(o => ({ waypoint: toWaypoint(o) })),
    destinations: [{ waypoint: toWaypoint(destination) }],
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE', // 候補比較用途のため精度よりコスト・速度を優先
  };

  const result = await fetchGoogleRoutesApi(ROUTES_COMPUTE_ROUTE_MATRIX_URL, fieldMask, body);
  if (!result.ok) {
    return origins.map(() => ({ status: 'API_ERROR' as const, durationMinutes: null, distanceKm: null }));
  }

  const elements: any[] = Array.isArray(result.body) ? result.body : [];
  return origins.map((_, originIndex) => {
    const element = elements.find(e => e?.originIndex === originIndex || (originIndex === 0 && e?.originIndex === undefined));
    if (!element) {
      return { status: 'API_ERROR' as const, durationMinutes: null, distanceKm: null };
    }
    // Google Route Matrixの要素ごとのstatus（0/未設定=OK、それ以外はエラー・経路なし）。
    // 実際のエラーコード体系はAPI実接続時に検証が必要（現状APIキー未設定のため未検証）。
    const statusCode = element.status?.code;
    if (statusCode !== undefined && statusCode !== 0) {
      return { status: 'NO_ROUTE' as const, durationMinutes: null, distanceKm: null };
    }
    const durationMinutes = parseDurationSecondsToMinutes(element.duration);
    const distanceKm = metersToKm(element.distanceMeters);
    if (durationMinutes === null || distanceKm === null) {
      return { status: 'API_ERROR' as const, durationMinutes: null, distanceKm: null };
    }
    return { status: 'SUCCESS' as const, durationMinutes, distanceKm };
  });
}

// restaurant → customer の走行時間・距離を取得する（Delivery Fee/Minimum Order/Driver Rewardの基準）。
// 【重要】driver base → restaurant とは完全に別の区間・別の関数であり、絶対に混同しないこと。
// 【Place ID→Routes接続・社長承認】destinationPlaceIdは末尾の任意引数。
// originは従来どおり必ずLatLngが必須（加盟店側はPlace ID化しない、社長指示）。
// destinationは「有効なPlace IDがある」または「有効な座標がある」のいずれかを満たせばよい。
// 両方とも無い場合は、従来どおりINVALID_LOCATIONとして扱う（推測しない）。
export async function computeRestaurantToCustomerRoute(
  origin: LatLng | null,
  destination: LatLng | null,
  departureTime: Date,
  destinationPlaceId?: string | null
): Promise<RouteLookupResult> {
  if (!isGoogleMapsConfigured()) {
    // APIキー未設定：推測せず、そもそも問い合わせを試みない。
    return { status: 'NOT_ATTEMPTED', durationMinutes: null, distanceKm: null };
  }
  if (!isValidLatLng(origin)) {
    // 店舗（加盟店）の座標が未確定/不正：AREA_COORDS等へのフォールバックは行わない。
    return { status: 'INVALID_LOCATION', durationMinutes: null, distanceKm: null };
  }
  const hasValidDestinationPlaceId = typeof destinationPlaceId === 'string' && destinationPlaceId.trim().length > 0;
  if (!isValidLatLng(destination) && !hasValidDestinationPlaceId) {
    // 宿泊施設の座標・Place IDのいずれも未確定/不正：従来どおりINVALID_LOCATION。
    return { status: 'INVALID_LOCATION', durationMinutes: null, distanceKm: null };
  }
  return callComputeRoutes(origin, destination, departureTime, hasValidDestinationPlaceId ? destinationPlaceId : null);
}

// driver base → restaurant の距離（必要なら時間も）を取得する（Remote Dispatch Bonusの判定根拠）。
// 複数のドライバー拠点候補をまとめて1回のRoute Matrix呼び出しで問い合わせる想定。
export async function computeDriverToRestaurantRoutes(
  driverBases: LatLng[],
  restaurant: LatLng | null
): Promise<RouteLookupResult[]> {
  if (!isGoogleMapsConfigured()) {
    return driverBases.map(() => ({ status: 'NOT_ATTEMPTED' as const, durationMinutes: null, distanceKm: null }));
  }
  if (!isValidLatLng(restaurant)) {
    return driverBases.map(() => ({ status: 'INVALID_LOCATION' as const, durationMinutes: null, distanceKm: null }));
  }
  // 個々のドライバー拠点座標が不正な場合は、そのドライバーだけINVALID_LOCATIONとして扱う
  // （他の有効な候補の判定を巻き込んで止めない）。
  const validIndices: number[] = [];
  const results: RouteLookupResult[] = driverBases.map((base, i) => {
    if (!isValidLatLng(base)) {
      return { status: 'INVALID_LOCATION', durationMinutes: null, distanceKm: null };
    }
    validIndices.push(i);
    return { status: 'NOT_ATTEMPTED', durationMinutes: null, distanceKm: null }; // 後で上書きする仮値
  });

  const validBases = validIndices.map(i => driverBases[i]);
  if (validBases.length === 0) {
    return results;
  }

  // 実際の通信は次STEPで実装するため、現状のORD（GOOGLE_MAPS_API_KEY未設定）では
  // isGoogleMapsConfigured()のガードで必ず先に止まり、ここへは到達しない。
  const matrixResults = await callComputeRouteMatrix(validBases, restaurant, new Date());
  validIndices.forEach((originalIndex, j) => {
    results[originalIndex] = matrixResults[j];
  });
  return results;
}
