// ============================================================
// STEP2-D-3-C-3: Google Maps実走行時間・距離をORD料金判定へ接続する層
// 【重要】このファイルはcheckout/dispatch/DB保存のどこからも呼び出されていない
// （STEP2-D-3-C-3時点では「接続できる状態にする」までが範囲）。
//
// 責務：googleMapsClient.ts（実走行時間・距離の取得）と pricingRules.ts
// （時間・距離から料金階層を判定する既存ロジック）を橋渡しするだけの薄い層。
// どちらの既存ファイルも変更しない（既存のテスト済みロジックを一切壊さない）。
//
// restaurant → customer と driver base → restaurant は、
// 既存の型（RouteLookupResult等）の時点から区別されており、この層でも
// 変数名・関数名を分けて絶対に混同しない。
// ============================================================

import type { DatabaseSync } from 'node:sqlite';
import {
  LatLng,
  RouteLookupResult,
  computeRestaurantToCustomerRoute,
  computeDriverToRestaurantRoutes,
} from './googleMapsClient';
import { TierLookupResult, calculateDeliveryFee, calculateMinimumOrder, calculateRemoteDispatchBonus } from './pricingRules';

// 座標未確定・API失敗時に返す「算出不能」のTierLookupResult（推測値を絶対に作らない）。
const UNRESOLVED_TIER: TierLookupResult = { amount: null, isConsultation: true };

export interface RestaurantToCustomerPricingResult {
  mapsStatus: RouteLookupResult['status'];
  restaurantToCustomerDurationMinutes: number | null;
  restaurantToCustomerDistanceKm: number | null;
  deliveryFee: TierLookupResult;
  minimumOrder: TierLookupResult;
}

// restaurant → customer の実走行時間から、配送料・最低注文額を判定する。
// 【重要】routeLookup引数はテストでの依存注入用（デフォルトは実際のgoogleMapsClient.tsの実装）。
// 実運用では省略してよい。
export async function resolveRestaurantToCustomerPricing(
  db: DatabaseSync,
  restaurantLocation: LatLng | null,
  customerLocation: LatLng | null,
  departureTime: Date,
  routeLookup: typeof computeRestaurantToCustomerRoute = computeRestaurantToCustomerRoute
): Promise<RestaurantToCustomerPricingResult> {
  const route = await routeLookup(restaurantLocation, customerLocation, departureTime);

  if (route.status !== 'SUCCESS' || route.durationMinutes === null) {
    // 座標未確定(INVALID_LOCATION)・APIキー未設定(NOT_ATTEMPTED)・API失敗(API_ERROR/NO_ROUTE)、
    // いずれの場合も推測値を作らず、配送料・最低注文額は算出不能(Consultation)として返す。
    return {
      mapsStatus: route.status,
      restaurantToCustomerDurationMinutes: null,
      restaurantToCustomerDistanceKm: null,
      deliveryFee: UNRESOLVED_TIER,
      minimumOrder: UNRESOLVED_TIER,
    };
  }

  return {
    mapsStatus: 'SUCCESS',
    restaurantToCustomerDurationMinutes: route.durationMinutes,
    restaurantToCustomerDistanceKm: route.distanceKm,
    deliveryFee: calculateDeliveryFee(db, route.durationMinutes),
    minimumOrder: calculateMinimumOrder(db, route.durationMinutes),
  };
}

export interface DriverToRestaurantPricingEntry {
  mapsStatus: RouteLookupResult['status'];
  driverToRestaurantDistanceKm: number | null;
  remoteDispatchBonus: TierLookupResult;
}

// driver base → restaurant の実走行距離から、Remote Dispatch Bonusを判定する（複数候補一括）。
// 【重要】ドライバー基本報酬そのものはここでは一切扱わない（既存のDriver Reward判定は
// restaurant→customerの走行時間を使うため、resolveRestaurantToCustomerPricing()側の責務）。
export async function resolveDriverToRestaurantPricing(
  db: DatabaseSync,
  driverBases: LatLng[],
  restaurantLocation: LatLng | null,
  routeLookup: typeof computeDriverToRestaurantRoutes = computeDriverToRestaurantRoutes
): Promise<DriverToRestaurantPricingEntry[]> {
  const routes = await routeLookup(driverBases, restaurantLocation);

  return routes.map(route => {
    if (route.status !== 'SUCCESS' || route.distanceKm === null) {
      return {
        mapsStatus: route.status,
        driverToRestaurantDistanceKm: null,
        remoteDispatchBonus: UNRESOLVED_TIER,
      };
    }
    return {
      mapsStatus: 'SUCCESS',
      driverToRestaurantDistanceKm: route.distanceKm,
      remoteDispatchBonus: calculateRemoteDispatchBonus(db, route.distanceKm),
    };
  });
}
