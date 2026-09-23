// ============================================================
// 商品価格の正規参照データ（最小限、STEP2-C-5）
// 【重要】これは index.html 内の STORES 配列（価格に関わる部分のみ）を手動で複製した
// 読み取り専用データです。index.html 側は一切変更していません。
// 商品追加・価格変更のたびに、index.html とこのファイルの両方を手動で更新する必要があり、
// これは運用上の負荷になります（STEP2-C-4監査で確認済みの技術的負債）。
// 将来、加盟店・商品が本格的に増える場合は、
//   Backend価格参照(このファイル) → 共有データ構造 → SQLite商品マスタ
// の順に移行することを検討してください。今回は小規模スタートのための最小構成です。
// 管理画面からの価格変更機能は今回実装していません（意図的にreadonly）。
// ============================================================

export interface CatalogProduct {
  readonly productId: string;
  readonly storeId: string;
  readonly name: string;
  readonly price: number; // 正規単価（円）
}

export const PRICE_CATALOG: readonly CatalogProduct[] = [
  // s1: 琉球食堂 ちゅら島
  { productId: 'p1', storeId: 's1', name: 'ソーキそば', price: 980 },
  { productId: 'p2', storeId: 's1', name: 'ゴーヤチャンプルー', price: 880 },
  { productId: 'p3', storeId: 's1', name: '沖縄タコライス', price: 1080 },
  { productId: 'p4', storeId: 's1', name: 'ラフテー', price: 1280 },
  { productId: 'p5', storeId: 's1', name: 'じゅーしー', price: 680 },
  { productId: 'p6', storeId: 's1', name: 'サーターアンダギー(3個)', price: 450 },
  // s2: グリーンウェーブ オーガニックキッチン
  { productId: 'p7', storeId: 's2', name: '島野菜のヴィーガンチャンプルー', price: 1180 },
  { productId: 'p8', storeId: 's2', name: 'ゴーヤと豆乳のグリーンカレー', price: 1280 },
  { productId: 'p9', storeId: 's2', name: '大豆ミートのタコライス', price: 1180 },
  { productId: 'p10', storeId: 's2', name: '島豆腐のヴィーガンバーガー', price: 1380 },
  { productId: 'p11', storeId: 's2', name: '紅芋とココナッツのスムージーボウル', price: 980 },
  { productId: 'p12', storeId: 's2', name: '黒糖ヴィーガンパンケーキ', price: 880 },
  // s3: アルマナラ ハラールダイニング
  { productId: 'p13', storeId: 's3', name: 'ハラールチキンビリヤニ', price: 1480 },
  { productId: 'p14', storeId: 's3', name: 'ラム肉のグリル(ハラール)', price: 1980 },
  { productId: 'p15', storeId: 's3', name: 'チキンケバブプレート', price: 1380 },
  { productId: 'p16', storeId: 's3', name: '島魚とハラールスパイスのグリル', price: 1680 },
  { productId: 'p17', storeId: 's3', name: 'ハラールタコライス', price: 1280 },
  { productId: 'p18', storeId: 's3', name: 'ミントラッシー', price: 580 },
  // s4: オーシャンブルー カフェ&スイーツ
  { productId: 'p19', storeId: 's4', name: 'シークヮーサーソーダ', price: 580 },
  { productId: 'p20', storeId: 's4', name: '紅芋タルト', price: 580 },
  { productId: 'p21', storeId: 's4', name: 'ジェラート(2種盛り)', price: 680 },
  { productId: 'p22', storeId: 's4', name: 'パイナップルパンケーキ', price: 1080 },
  { productId: 'p23', storeId: 's4', name: '島バナナスムージー', price: 680 },
  { productId: 'p24', storeId: 's4', name: '塩ちんすこうパフェ', price: 880 },
  // s5: アズーラ・オキナワン フュージョンダイニング
  { productId: 'p25', storeId: 's5', name: '島魚のカルパッチョ', price: 2200 },
  { productId: 'p26', storeId: 's5', name: 'アグー豚のロースト', price: 4800 },
  { productId: 'p27', storeId: 's5', name: '石垣牛フィレステーキ', price: 6800 },
  { productId: 'p28', storeId: 's5', name: '海ぶどうとウニのパスタ', price: 3200 },
  { productId: 'p29', storeId: 's5', name: 'シェフおまかせコース(5品)', price: 9800 },
  { productId: 'p30', storeId: 's5', name: 'パッションフルーツのパンナコッタ', price: 1200 },
];

// 配送費：現状index.htmlの複数箇所にハードコードされている固定300円をそのまま複製したもの。
// 独自の配送費計算ルールは新設していない（既存ルールをbackend側にも反映しただけ）。
export const DELIVERY_FEE = 300;

// container fee（容器代）：現状のORDにはこの概念自体が実装されていないため、0円固定として扱う。
// 存在しない業務ルールを新設しないという方針に従い、今回は0円で確定する。
// 将来、容器代の概念が導入される場合は、その時点で正規のルールをここに反映すること。
export const CONTAINER_FEE = 0;

export function findProductById(productId: string): CatalogProduct | undefined {
  return PRICE_CATALOG.find(p => p.productId === productId);
}

// 商品名は複数店舗で重複する可能性があるため配列で返す（曖昧性を呼び出し側で明示的に扱うため）
export function findProductsByName(name: string): CatalogProduct[] {
  return PRICE_CATALOG.filter(p => p.name === name);
}
