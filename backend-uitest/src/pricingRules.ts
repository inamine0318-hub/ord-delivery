// ============================================================
// STEP2-D-2: ORD料金・利益計算ロジック
// 【重要】このファイルは backend/src/index.ts の validateAndRecalculateOrder() を
// 一切変更・参照しない、完全に独立したモジュールである。
// 「商品価格検証（validateAndRecalculateOrder、既存・不変）」→
// 「ORD料金計算（このファイル）」→「利益計算（このファイル）」という3段階の責務分離のうち、
// 後半2段階をここに実装する。前段の出力（商品合計金額など）は、呼び出し側が
// 単なる数値としてこのファイルの関数に渡すだけであり、型・関数レベルの結合は一切ない。
//
// このファイルは実DB（backend/data/ord.db）へ直接接続しない。pricing_rulesテーブルへの
// アクセスは、呼び出し側から渡されたDatabaseSyncインスタンス（index.tsの実DB、または
// テストの:memory:DB）を使って行う（依存注入）。これにより、テストコードから本物の
// このファイルをそのままimportして、実DBに一切触れずに検証できる。
//
// Google Maps API / Square API / LINE APIとの通信は一切含まない。
// deliveryTimeMinutes / driverToRestaurantDistanceKm / squareFeeRate は、
// すべて呼び出し側が数値として渡す入力値として扱う（STEP2-D-3, Square連携は別STEP）。
// ============================================================

import type { DatabaseSync } from 'node:sqlite';

// ORD内部の1注文あたり最低目標利益（円）。顧客には絶対に表示・説明しない。
export const PROFIT_THRESHOLD = 2000;

export type PricingRuleType = 'DELIVERY_FEE' | 'MINIMUM_ORDER' | 'DRIVER_REWARD' | 'REMOTE_DISPATCH_BONUS';
export type PricingRuleUnit = 'MINUTES' | 'KM';

export interface TierLookupResult {
  amount: number | null; // isConsultation===trueの場合は必ずnull（自動価格を出さない）
  isConsultation: boolean;
}

interface PricingRuleRow {
  range_min: number | null;
  range_max: number | null;
  amount: number | null;
  is_consultation: number;
  sort_order: number;
}

// pricing_rulesテーブルから該当区間を検索する共通ロジック。
// 区間の意味は「range_minを超え・range_max以下」（下限exclusive・上限inclusive）で統一されている
// （STEP2-D-1のテーブル設計に準拠。既存DB仕様をそのまま使用し、新しい判定規約は作らない）。
// range_min=NULLの行は「下限なし＝0以上を含む」を意味する。
// 例：0～20分の区間は range_min=NULL, range_max=20 であり、ちょうど20は含む・
// ちょうど21は含まない（次の区間range_min=20, range_max=30に入る）。
export function lookupPricingTier(
  db: DatabaseSync,
  ruleType: PricingRuleType,
  unit: PricingRuleUnit,
  value: number
): TierLookupResult {
  // 不正な入力（NaN/Infinity/文字列/undefined相当/負数）は、自動価格を絶対に出さないという
  // 方針に従い安全側でConsultation扱いにする。走行時間・距離が負数になることはあり得ないため
  // 負数も不正値として扱う。
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { amount: null, isConsultation: true };
  }

  const rows = db
    .prepare(
      'SELECT range_min, range_max, amount, is_consultation, sort_order FROM pricing_rules WHERE rule_type = ? AND unit = ? ORDER BY sort_order'
    )
    .all(ruleType, unit) as unknown as PricingRuleRow[];

  for (const r of rows) {
    const minOk = r.range_min === null || value > r.range_min;
    const maxOk = r.range_max === null || value <= r.range_max;
    if (minOk && maxOk) {
      if (r.is_consultation) return { amount: null, isConsultation: true };
      return { amount: r.amount, isConsultation: false };
    }
  }
  // 該当区間が1件も見つからない場合（シード未実行等の異常系）も、自動価格を出さない安全側フォールバック。
  return { amount: null, isConsultation: true };
}

// ---- 個別の料金判定関数（責務ごとに分離。いずれも副作用なしの純粋関数） ----

// 顧客配送料（店舗(restaurant)→顧客の実走行時間で判定）
export function calculateDeliveryFee(db: DatabaseSync, deliveryTimeMinutes: number): TierLookupResult {
  return lookupPricingTier(db, 'DELIVERY_FEE', 'MINUTES', deliveryTimeMinutes);
}

// 最低注文額の「区分ごとの基準額」（店舗(restaurant)→顧客の実走行時間で判定）。
// 実際の注文金額との達成/未達判定は checkMinimumOrder() で行う（責務を分離している）。
export function calculateMinimumOrder(db: DatabaseSync, deliveryTimeMinutes: number): TierLookupResult {
  return lookupPricingTier(db, 'MINIMUM_ORDER', 'MINUTES', deliveryTimeMinutes);
}

// ドライバー基本報酬（店舗(restaurant)→顧客の実走行時間で判定。燃料費込み）
export function calculateDriverReward(db: DatabaseSync, deliveryTimeMinutes: number): TierLookupResult {
  return lookupPricingTier(db, 'DRIVER_REWARD', 'MINUTES', deliveryTimeMinutes);
}

// 遠隔ドライバーボーナス（ドライバー拠点(driver base)→店舗(restaurant)の距離で判定）。
// 【重要】上記3関数が使う「店舗→顧客」の走行時間とは完全に別の区間・別の目的の値であり、
// 絶対に混同しないこと。
export function calculateRemoteDispatchBonus(db: DatabaseSync, driverToRestaurantDistanceKm: number): TierLookupResult {
  return lookupPricingTier(db, 'REMOTE_DISPATCH_BONUS', 'KM', driverToRestaurantDistanceKm);
}

export interface DeliveryRulesInput {
  // 店舗(restaurant) → 顧客 の実走行時間（分）。顧客配送料・最低注文額・ドライバー基本報酬に使用。
  // Google Maps未接続の間は、呼び出し側が仮の数値を渡すことでこの関数単体をテストできる。
  deliveryTimeMinutes: number;
  // ドライバー拠点(driver base) → 店舗(restaurant) の距離（km）。Remote Dispatch Bonusにのみ使用。
  driverToRestaurantDistanceKm: number;
}

export interface DeliveryRulesResult {
  deliveryTimeMinutes: number;
  driverToRestaurantDistanceKm: number;
  deliveryFee: TierLookupResult;
  minimumOrder: TierLookupResult;
  driverReward: TierLookupResult;
  remoteDispatchBonus: TierLookupResult;
  // 上記いずれか1つでもConsultationならtrue（60分超・20km超のどちらか一方でも成立する）
  isConsultation: boolean;
}

// 上記4関数をまとめて呼び出す便宜関数（よくある呼び出しパターンをまとめただけで、
// 個別の判定ロジック自体は各関数に閉じている）。
export function calculateDeliveryRules(db: DatabaseSync, input: DeliveryRulesInput): DeliveryRulesResult {
  const deliveryFee = calculateDeliveryFee(db, input.deliveryTimeMinutes);
  const minimumOrder = calculateMinimumOrder(db, input.deliveryTimeMinutes);
  const driverReward = calculateDriverReward(db, input.deliveryTimeMinutes);
  const remoteDispatchBonus = calculateRemoteDispatchBonus(db, input.driverToRestaurantDistanceKm);

  return {
    deliveryTimeMinutes: input.deliveryTimeMinutes,
    driverToRestaurantDistanceKm: input.driverToRestaurantDistanceKm,
    deliveryFee,
    minimumOrder,
    driverReward,
    remoteDispatchBonus,
    isConsultation:
      deliveryFee.isConsultation ||
      minimumOrder.isConsultation ||
      driverReward.isConsultation ||
      remoteDispatchBonus.isConsultation,
  };
}

// ============================================================
// 最低注文額の達成/未達判定
// 【重要】判定は「ORD顧客販売価格の商品合計」に対して行う。加盟店通常価格ではない。
// 既存の店舗別minOrder（index.html、変更しない）は今回一切参照しない。
// ============================================================
export interface MinimumOrderCheckInput {
  minimumOrderAmount: number | null; // calculateMinimumOrder().amount をそのまま渡す想定
  customerFoodSubtotal: number; // ORD販売価格ベースの商品合計（配送料等を含まない）
}
export interface MinimumOrderCheckResult {
  minimumOrderAmount: number | null;
  customerFoodSubtotal: number;
  minimumOrderMet: boolean;
  minimumOrderShortfall: number | null; // 不足額（達成時は0）。判定不能(Consultation等)時はnull
}
export function checkMinimumOrder(input: MinimumOrderCheckInput): MinimumOrderCheckResult {
  if (
    input.minimumOrderAmount === null ||
    typeof input.customerFoodSubtotal !== 'number' ||
    !Number.isFinite(input.customerFoodSubtotal) ||
    input.customerFoodSubtotal < 0
  ) {
    // 最低注文額が確定できない(Consultation区分等)、または商品合計が不正な場合、
    // 達成/未達を判定できないため安全側でminimumOrderMet=falseとし、
    // 不足額は「不明」を意味するnullにする。
    return {
      minimumOrderAmount: input.minimumOrderAmount,
      customerFoodSubtotal: input.customerFoodSubtotal,
      minimumOrderMet: false,
      minimumOrderShortfall: null,
    };
  }
  const shortfall = Math.max(0, input.minimumOrderAmount - input.customerFoodSubtotal);
  return {
    minimumOrderAmount: input.minimumOrderAmount,
    customerFoodSubtotal: input.customerFoodSubtotal,
    minimumOrderMet: shortfall === 0,
    minimumOrderShortfall: shortfall,
  };
}

// ============================================================
// 加盟店別価格ルール（拡張ポイントの型と空レジストリのみ。STEP2-D-2では未登録）
// 【重要】Gajimaruの「(通常価格+容器代)×1.4」等、具体的な計算式は今回実装しない。
// 現行5店舗を含め、いかなる店舗もここには登録しない。
// ============================================================
export interface MerchantPricingRule {
  // ORD販売価格 = 加盟店通常価格から算出する計算式（将来、新規商品追加時の参考計算用）。
  computeSalePrice(merchantRegularPrice: number): number;
  // ORDが加盟店へ支払う金額 = ORD販売価格から逆算する。
  computeMerchantPayout(salePrice: number): number;
}

// 加盟店識別子（priceCatalog.ts側のstoreId、例:'s1'）をキーに個別ルールを登録するレジストリ。
// 【STEP2-D-2時点で意図的に空】：加盟店通常価格データがBackendのどこにも存在しないため
// （調査済み。priceCatalog.tsはORD販売価格のみ保持）、いかなる店舗の支払いルールも
// ここでは確定できない。Gajimaruの登録・具体的な計算式の実装は、価格マスタと
// 加盟店情報が正式に整理された別STEPで行う。
const MERCHANT_PRICING_RULES: Partial<Record<string, MerchantPricingRule>> = {};

export function getMerchantPricingRule(storeId: string | null): MerchantPricingRule | undefined {
  return storeId ? MERCHANT_PRICING_RULES[storeId] : undefined;
}

// 加盟店への支払額を算出する。
// 【重要】既存のcommissionRateForStore()/DEFAULT_COMMISSION_RATE（index.ts、既存の
// 加盟店精算機能専用）は一切参照しない。ORD販売価格に対する一律%オフのコミッション
// モデルと、「加盟店通常価格に基づく支払い」は別の概念であり、混同すると実態と異なる
// 架空の利益数値を生む（STEP2-D-2設計確認で確定した方針）。
// 加盟店固有ルールが登録されていればその支払額を返す。登録されていない場合
// （STEP2-D-2時点では常にこちら）は、架空の金額を生成せずnullを返す。
export function computeMerchantPayout(storeId: string | null, salePrice: number): number | null {
  const rule = getMerchantPricingRule(storeId);
  if (!rule) return null;
  return rule.computeMerchantPayout(salePrice);
}

// ============================================================
// ORD利益計算・¥2,000利益ゲート
// ============================================================
export interface ProfitCalculationInput {
  customerFoodSubtotal: number; // ORD商品販売価格合計
  merchantPayout: number | null; // computeMerchantPayout()の結果。nullなら算出不能
  deliveryFee: number; // 顧客配送料（Consultation区分では呼び出さないこと。amount===nullを渡さない）
  // Square決済手数料率(0〜1)。
  // 【重要】ORDの既存コードにSquare決済手数料率の確定設定は存在しない（再確認済み）。
  // そのためこのファイルはデフォルト値・仮値を一切持たない。必須引数として受け取る。
  squareFeeRate: number;
  driverReward: number;
  remoteDispatchBonus: number;
  otherVariableCosts?: number; // その他注文単位の変動費。未指定時は0
}

export interface ProfitBreakdown {
  customerFoodSubtotal: number;
  merchantPayout: number;
  deliveryFee: number;
  squareFee: number;
  driverReward: number;
  remoteDispatchBonus: number;
  otherVariableCosts: number;
}

// 算出可能な場合と、算出不能（merchantPayout未確定・入力値不正）な場合を型レベルで区別する。
// 【重要】算出不能な場合に架空の利益額を返してはならない（呼び出し側はdeterminable===false時、
// 自動確定させず例外処理へ回す設計にすること）。
export type ProfitCalculationResult =
  | {
      determinable: true;
      estimatedOrdProfit: number;
      profitThreshold: number;
      profitGatePassed: boolean;
      breakdown: ProfitBreakdown;
    }
  | {
      determinable: false;
      reason: string;
    };

function isValidNonNegativeFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

// ORD利益 = 商品販売価格合計 − 加盟店支払額 + 顧客配送料 − Square決済手数料
//           − ドライバー基本報酬 − Remote Dispatch Bonus − その他変動費
// Square決済手数料は「顧客が実際に支払う金額（商品合計＋配送料）」に対して発生するものとして計算する
// （Square側は取引総額に対して手数料を課すため）。
export function calculateOrdProfit(input: ProfitCalculationInput): ProfitCalculationResult {
  if (input.merchantPayout === null) {
    return { determinable: false, reason: '加盟店への支払額(merchantPayout)が確定していないため利益を算出できません' };
  }
  if (
    !isValidNonNegativeFinite(input.customerFoodSubtotal) ||
    !isValidNonNegativeFinite(input.merchantPayout) ||
    !isValidNonNegativeFinite(input.deliveryFee) ||
    !isValidNonNegativeFinite(input.squareFeeRate) ||
    !isValidNonNegativeFinite(input.driverReward) ||
    !isValidNonNegativeFinite(input.remoteDispatchBonus) ||
    (input.otherVariableCosts !== undefined && !isValidNonNegativeFinite(input.otherVariableCosts))
  ) {
    return { determinable: false, reason: '入力値に不正な値（NaN/Infinity/負数/非数値）が含まれているため利益を算出できません' };
  }

  const otherVariableCosts = input.otherVariableCosts ?? 0;
  const squareFee = Math.round((input.customerFoodSubtotal + input.deliveryFee) * input.squareFeeRate);
  const estimatedOrdProfit =
    input.customerFoodSubtotal -
    input.merchantPayout -
    squareFee +
    input.deliveryFee -
    input.driverReward -
    input.remoteDispatchBonus -
    otherVariableCosts;

  return {
    determinable: true,
    estimatedOrdProfit,
    profitThreshold: PROFIT_THRESHOLD,
    profitGatePassed: estimatedOrdProfit >= PROFIT_THRESHOLD,
    breakdown: {
      customerFoodSubtotal: input.customerFoodSubtotal,
      merchantPayout: input.merchantPayout,
      deliveryFee: input.deliveryFee,
      squareFee,
      driverReward: input.driverReward,
      remoteDispatchBonus: input.remoteDispatchBonus,
      otherVariableCosts,
    },
  };
}
