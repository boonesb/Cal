import './style.css';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth';
import { auth, db } from './firebase';
import { BUILD_TIME_ISO } from './generated/version';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';

const INACTIVITY_LIMIT_MS = 30 * 60 * 1000;

const appEl = document.querySelector<HTMLDivElement>('#app');

if (!appEl) {
  throw new Error('Missing app container');
}

const parseYmdToLocalDate = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map((part) => Number(part));
  return new Date(y, (m || 1) - 1, d || 1);
};

const formatLocalDateToYmd = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addDays = (ymd: string, delta: number) => {
  const date = parseYmdToLocalDate(ymd);
  date.setDate(date.getDate() + delta);
  return formatLocalDateToYmd(date);
};

const todayStr = () => {
  const now = new Date();
  return formatLocalDateToYmd(now);
};

type Food = {
  id: string;
  name: string;
  caloriesPerServing: number;
  carbsPerServing: number;
  proteinPerServing: number;
  favorite: boolean;
  barcode?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  servingSizeGrams?: number;
};

type FoodDraft = {
  name: string;
  caloriesPerServing: number;
  carbsPerServing: number;
  proteinPerServing: number;
  servingLabel?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  servingSizeGrams?: number;
};

type Entry = {
  id: string;
  foodName: string;
  servings: number;
  caloriesPerServing: number;
  carbsPerServing: number;
  proteinPerServing: number;
  createdAt?: string;
};

type WaterLog = {
  id: string;
  userId: string;
  date: string;
  amountMl: number;
  createdAt?: string;
};

const USDA_API_KEY = import.meta.env.VITE_USDA_API_KEY as string | undefined;
const BUILD_TIMESTAMP = import.meta.env.BUILD_TIMESTAMP ?? BUILD_TIME_ISO;
const formatBuildTimestamp = (value: string) => {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getFullYear();
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    const hours = String(parsed.getHours()).padStart(2, '0');
    const minutes = String(parsed.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }
  return value.replace('T', ' ').slice(0, 16);
};

type View = 'dashboard' | 'foods' | 'add-entry' | 'edit-entry' | 'add-food';

const state: {
  user: User | null;
  selectedDate: string;
  view: View;
  currentView: 'dashboard' | 'foods' | 'entry';
  foodCache: Food[];
  entryFormFoodCacheLoaded: boolean;
  inactivityTimer: number | null;
  entryReturnContext: { date: string } | null;
  prefillFoodId?: string;
  pendingEntryFoodName?: string;
  returnToEntryAfterFoodSave: boolean;
  isMobile: boolean;
  lastWaterMl?: number;
  usdaSearchTerm: string;
  usdaSearchResults: UsdaFoodResult[];
  usdaSearchHasSearched: boolean;
} = {
  user: null,
  selectedDate: todayStr(),
  view: 'dashboard',
  currentView: 'dashboard',
  foodCache: [],
  entryFormFoodCacheLoaded: false,
  inactivityTimer: null,
  entryReturnContext: null,
  pendingEntryFoodName: undefined,
  returnToEntryAfterFoodSave: false,
  isMobile: window.matchMedia('(max-width: 640px)').matches,
  lastWaterMl: undefined,
  usdaSearchTerm: '',
  usdaSearchResults: [],
  usdaSearchHasSearched: false,
};

const resetInactivityTimer = () => {
  if (!state.user) return;
  if (state.inactivityTimer) {
    window.clearTimeout(state.inactivityTimer);
  }
  state.inactivityTimer = window.setTimeout(async () => {
    await signOut(auth);
    alert('Signed out due to 30 minutes of inactivity.');
  }, INACTIVITY_LIMIT_MS);
};

['click', 'keydown', 'touchstart', 'scroll'].forEach((evt) => {
  document.addEventListener(evt, resetInactivityTimer);
});


const formatNumberSmart = (num: number) => {
  const rounded = Math.round(num * 100) / 100;
  return rounded.toFixed(2).replace(/\.?0+$/, '');
};

const formatDisplayDate = (ymd: string) => {
  const date = parseYmdToLocalDate(ymd);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const applyViewState = (view: View, payload?: { returnDate?: string }) => {
  if (view === 'add-food') {
    state.returnToEntryAfterFoodSave = Boolean(payload?.returnDate ?? state.returnToEntryAfterFoodSave);
  } else {
    state.returnToEntryAfterFoodSave = false;
  }
  state.view = view;
  state.currentView =
    view === 'dashboard'
      ? 'dashboard'
      : view === 'foods' || (view === 'add-food' && !state.returnToEntryAfterFoodSave)
        ? 'foods'
        : 'entry';
};

const parseDecimal2 = (raw: string, min: number) => {
  const sanitized = raw.replace(/[^0-9.]/g, '');
  const parts = sanitized.split('.');
  const whole = parts[0] || '0';
  const decimals = parts.length > 1 ? parts.slice(1).join('') : '';
  const normalized = decimals ? `${whole}.${decimals.slice(0, 2)}` : whole;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return min;
  const rounded = Math.round(parsed * 100) / 100;
  return Math.max(min, rounded);
};

const parseDecimalNullable = (raw: string, min: number) => {
  const sanitized = raw.replace(/[^0-9.]/g, '');
  if (!sanitized.trim()) return null;
  const parts = sanitized.split('.');
  const whole = parts[0] || '0';
  const decimals = parts.length > 1 ? parts.slice(1).join('') : '';
  const normalized = decimals ? `${whole}.${decimals.slice(0, 2)}` : whole;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed * 100) / 100;
  return Math.max(min, rounded);
};

const roundTo2 = (num: number) => Math.round(num * 100) / 100;
const roundTo1 = (num: number) => Math.round(num * 10) / 10;
const PER_100G_UNIT = 'per100g';

const attachSelectAllOnFocus = (input: HTMLInputElement | null) => {
  if (!input) return;
  const scheduleSelect = () => {
    requestAnimationFrame(() => {
      if (document.activeElement !== input) return;
      input.select();
      setTimeout(() => {
        if (document.activeElement === input) input.select();
      }, 0);
    });
  };
  const handlePointerUp = (event: Event) => {
    if (input.selectionStart === input.selectionEnd) {
      event.preventDefault();
      scheduleSelect();
    }
  };
  input.addEventListener('focus', scheduleSelect);
  input.addEventListener('mouseup', handlePointerUp);
  input.addEventListener('pointerup', handlePointerUp);
  input.addEventListener('touchend', handlePointerUp);
};

const OUNCE_TO_ML = 29.5735;
const WATER_PRESETS_OZ = [8, 12, 16, 20, 24, 32];

const ozToMl = (oz: number) => Math.round(oz * OUNCE_TO_ML);
const mlToOz = (ml: number) => Math.round(ml / OUNCE_TO_ML);

const renderMacroChips = (options: {
  calories: number;
  carbs: number;
  protein: number;
  variant?: 'subtle' | 'solid';
  label?: string;
  layout?: 'row' | 'grid';
  align?: 'start' | 'center';
  className?: string;
}) => {
  const { calories, carbs, protein, variant = 'solid', label, layout = 'row', align = 'start', className } = options;
  const chipClass = variant === 'subtle' ? 'chip subtle' : 'chip';
  const rowClasses = ['chip-row'];
  if (layout === 'grid') rowClasses.push('chip-row--grid');
  if (align === 'center') rowClasses.push('chip-row--center');
  if (className) rowClasses.push(className);
  return `
    <div class="${rowClasses.join(' ')}">
      ${label ? `<span class="chip-label chip-label--section">${label}</span>` : ''}
      <div class="${chipClass} macro-chip"><span class="chip-label">kcal</span><span class="chip-value">${formatNumberSmart(
        calories
      )}</span></div>
      <div class="${chipClass} macro-chip"><span class="chip-label">carbs</span><span class="chip-value">${formatNumberSmart(
        carbs
      )} g</span></div>
      <div class="${chipClass} macro-chip"><span class="chip-label">protein</span><span class="chip-value">${formatNumberSmart(
        protein
      )} g</span></div>
    </div>
  `;
};

const renderMacroSummary = (options: {
  calories: number;
  carbs: number;
  protein: number;
  label?: string;
  variant?: 'hero' | 'compact' | 'inline';
  className?: string;
}) => {
  const { calories, carbs, protein, label, variant = 'compact', className } = options;
  const caloriesText = `${formatNumberSmart(calories)} kcal`;
  const carbsText = `${formatNumberSmart(carbs)}g carbs`;
  const proteinText = `${formatNumberSmart(protein)}g protein`;
  if (variant === 'inline') {
    const labelText = label ? `${label} • ` : '';
    return `<div class="macro-inline ${className ?? ''}">${labelText}${caloriesText} • ${carbsText} • ${proteinText}</div>`;
  }
  const classes = ['macro-summary', `macro-summary--${variant}`];
  if (className) classes.push(className);
  return `
    <div class="${classes.join(' ')}">
      ${label ? `<div class="macro-summary__label">${label}</div>` : ''}
      <div class="macro-summary__primary">${caloriesText}</div>
      <div class="macro-summary__secondary">${carbsText} • ${proteinText}</div>
    </div>
  `;
};

const renderHeroMetrics = (options: {
  calories: number;
  carbs: number;
  protein: number;
  className?: string;
}) => {
  const { calories, carbs, protein, className } = options;
  const classes = ['hero-metrics'];
  if (className) classes.push(className);
  return `
    <div class="${classes.join(' ')}">
      <div class="hero-metric">
        <div class="hero-metric-label">Calories</div>
        <div class="hero-metric-value">${formatNumberSmart(calories)}</div>
        <div class="hero-metric-unit">kcal</div>
      </div>
      <div class="hero-metric">
        <div class="hero-metric-label">Carbs</div>
        <div class="hero-metric-value">${formatNumberSmart(carbs)}</div>
        <div class="hero-metric-unit">g</div>
      </div>
      <div class="hero-metric">
        <div class="hero-metric-label">Protein</div>
        <div class="hero-metric-value">${formatNumberSmart(protein)}</div>
        <div class="hero-metric-unit">g</div>
      </div>
    </div>
  `;
};

const getUsdaServingGrams = (result: UsdaFoodResult) => {
  const servingSize = result.servingSize;
  const normalizedUnit = normalizeServingUnit(result.servingSizeUnit);
  if (!Number.isFinite(servingSize) || servingSize == null) return null;
  if (normalizedUnit !== 'g') return null;
  return Number(servingSize);
};

type UsdaFoodResult = {
  id: string;
  description: string;
  dataType?: string;
  brandOwner?: string;
  brandName?: string;
  foodCategory?: string;
  brandedFoodCategory?: string;
  labelCalories?: number | null;
  calories: number | null;
  carbs: number | null;
  protein: number | null;
  gtinUpc?: string;
  servingSize?: number;
  servingSizeUnit?: string;
};

const searchUsdaFoods = async (term: string): Promise<UsdaFoodResult[]> => {
  if (!USDA_API_KEY) {
    throw new Error('Add VITE_USDA_API_KEY to use USDA lookups.');
  }
  const url = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
  url.searchParams.set('api_key', USDA_API_KEY);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: term, pageSize: 15 }),
  });
  if (!response.ok) {
    throw new Error('Unable to fetch USDA results right now.');
  }
  const data = await response.json();
  if (!data?.foods?.length) return [];

  return data.foods.map((food: any) => {
    const nutrients = food.foodNutrients || [];
    const findNutrient = (id: string) => {
      const nutrient = nutrients.find((n: any) => {
        const nid = n.nutrientId ?? n.nutrientNumber ?? n.nutrient?.id;
        return String(nid) === id;
      });
      if (!nutrient) return null;
      const rawValue = nutrient?.value ?? nutrient?.amount;
      if (rawValue == null) return null;
      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const servingSizeValue = Number(food.servingSize);
    const labelCaloriesValue = Number(food?.labelNutrients?.calories?.value);
    const foodCategory =
      typeof food.foodCategory === 'string' ? food.foodCategory : food.foodCategory?.description ?? undefined;
    return {
      id: String(food.fdcId ?? food.description),
      description: String(food.description ?? ''),
      dataType: food.dataType ? String(food.dataType) : undefined,
      brandOwner: food.brandOwner ? String(food.brandOwner) : undefined,
      brandName: food.brandName ? String(food.brandName) : undefined,
      foodCategory: foodCategory ? String(foodCategory) : undefined,
      brandedFoodCategory: food.brandedFoodCategory ? String(food.brandedFoodCategory) : undefined,
      labelCalories: Number.isFinite(labelCaloriesValue) ? labelCaloriesValue : null,
      calories: findNutrient('1008'),
      carbs: findNutrient('1005'),
      protein: findNutrient('1003'),
      gtinUpc: food.gtinUpc ? String(food.gtinUpc) : undefined,
      servingSize: Number.isFinite(servingSizeValue) ? servingSizeValue : undefined,
      servingSizeUnit: food.servingSizeUnit ? String(food.servingSizeUnit) : undefined,
    } as UsdaFoodResult;
  });
};

const searchUsdaFoodsByBarcode = async (barcode: string): Promise<UsdaFoodResult[]> => {
  if (!USDA_API_KEY) {
    throw new Error('Add VITE_USDA_API_KEY to use USDA lookups.');
  }
  const url = new URL('https://api.nal.usda.gov/fdc/v1/foods/search');
  url.searchParams.set('api_key', USDA_API_KEY);

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: barcode, pageSize: 8, dataType: ['Branded'] }),
  });
  if (!response.ok) {
    throw new Error('Unable to fetch USDA results right now.');
  }
  const data = await response.json();
  if (!data?.foods?.length) return [];

  return data.foods.map((food: any) => {
    const nutrients = food.foodNutrients || [];
    const findNutrient = (id: string) => {
      const nutrient = nutrients.find((n: any) => {
        const nid = n.nutrientId ?? n.nutrientNumber ?? n.nutrient?.id;
        return String(nid) === id;
      });
      if (!nutrient) return null;
      const rawValue = nutrient?.value ?? nutrient?.amount;
      if (rawValue == null) return null;
      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const servingSizeValue = Number(food.servingSize);
    const labelCaloriesValue = Number(food?.labelNutrients?.calories?.value);
    const foodCategory =
      typeof food.foodCategory === 'string' ? food.foodCategory : food.foodCategory?.description ?? undefined;
    return {
      id: String(food.fdcId ?? food.description),
      description: String(food.description ?? ''),
      dataType: food.dataType ? String(food.dataType) : undefined,
      brandOwner: food.brandOwner ? String(food.brandOwner) : undefined,
      brandName: food.brandName ? String(food.brandName) : undefined,
      foodCategory: foodCategory ? String(foodCategory) : undefined,
      brandedFoodCategory: food.brandedFoodCategory ? String(food.brandedFoodCategory) : undefined,
      labelCalories: Number.isFinite(labelCaloriesValue) ? labelCaloriesValue : null,
      calories: findNutrient('1008'),
      carbs: findNutrient('1005'),
      protein: findNutrient('1003'),
      gtinUpc: food.gtinUpc ? String(food.gtinUpc) : undefined,
      servingSize: Number.isFinite(servingSizeValue) ? servingSizeValue : undefined,
      servingSizeUnit: food.servingSizeUnit ? String(food.servingSizeUnit) : undefined,
    } as UsdaFoodResult;
  });
};

const normalizeBarcode = (value: string) => value.trim().replace(/\D/g, '');

const isValidBarcode = (barcode: string) => barcode.length >= 8 && barcode.length <= 14;

const parseServingSize = (value: string) => {
  const match = value.match(/(\d+(?:[.,]\d+)?)\s*(g|ml)\b/i);
  if (!match) return null;
  const amount = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase() === 'ml' ? 'ml' : 'g';
  return {
    amount,
    unit,
    label: `${formatNumberSmart(amount)} ${unit}`,
  };
};

type ServingAnchor = {
  amount: number;
  unit: 'g' | 'ml';
  label: string;
};

const isPer100gUnit = (unit?: string) => unit?.trim().toLowerCase() === PER_100G_UNIT;

const normalizeServingUnit = (unit?: string) => {
  if (!unit) return null;
  const normalized = unit.trim().toLowerCase();
  if (normalized === PER_100G_UNIT) return null;
  if (normalized === 'g' || normalized === 'gram' || normalized === 'grams') return 'g';
  if (
    normalized === 'ml' ||
    normalized === 'milliliter' ||
    normalized === 'milliliters' ||
    normalized === 'millilitre' ||
    normalized === 'millilitres'
  )
    return 'ml';
  return null;
};

const buildServingAnchor = (amount?: number, unit?: string): ServingAnchor | null => {
  if (!Number.isFinite(amount) || amount == null || amount <= 0) return null;
  const normalizedUnit = normalizeServingUnit(unit);
  if (!normalizedUnit) return null;
  return {
    amount,
    unit: normalizedUnit,
    label: `${formatNumberSmart(amount)} ${normalizedUnit}`,
  };
};

const resolveServingAnchor = (options: {
  servingSizeGrams?: number;
  servingSize?: number;
  servingSizeUnit?: string;
  servingLabel?: string;
}) => {
  if (isPer100gUnit(options.servingSizeUnit)) {
    return null;
  }
  if (Number.isFinite(options.servingSizeGrams) && (options.servingSizeGrams ?? 0) > 0) {
    const amount = options.servingSizeGrams ?? 0;
    return {
      amount,
      unit: 'g',
      label: `${formatNumberSmart(amount)} g`,
    } as ServingAnchor;
  }
  const fromSizedUnit = buildServingAnchor(options.servingSize, options.servingSizeUnit);
  if (fromSizedUnit) return fromSizedUnit;
  if (options.servingLabel) {
    const parsed = parseServingSize(options.servingLabel);
    if (parsed) return parsed;
  }
  return null;
};

const getNutritionBasisLabel = (anchor: ServingAnchor | null) =>
  anchor ? `Per serving (${anchor.label})` : 'Per 100 g';

const getManualNutritionBasisLabel = (grams?: number) => {
  if (Number.isFinite(grams) && (grams ?? 0) > 0) {
    return `Per serving (${formatNumberSmart(grams ?? 0)} g)`;
  }
  return 'Per serving (grams)';
};

const getFoodBasis = (food: Pick<Food, 'servingSize' | 'servingSizeUnit' | 'servingSizeGrams'>) => {
  const anchor = resolveServingAnchor({
    servingSizeGrams: food.servingSizeGrams,
    servingSize: food.servingSize,
    servingSizeUnit: food.servingSizeUnit,
  });
  return { anchor, label: getNutritionBasisLabel(anchor) };
};

const hasTrueServing = (food?: Pick<Food, 'servingSizeGrams' | 'servingSize' | 'servingSizeUnit'>) => {
  if (!food) return false;
  if (isPer100gUnit(food.servingSizeUnit)) return false;
  const anchor = resolveServingAnchor({
    servingSizeGrams: food.servingSizeGrams,
    servingSize: food.servingSize,
    servingSizeUnit: food.servingSizeUnit,
  });
  return Boolean(anchor);
};

const getServingSizeGramsValue = (
  food?: Pick<Food, 'servingSizeGrams' | 'servingSize' | 'servingSizeUnit'>
) => {
  if (!food) return null;
  if (isPer100gUnit(food.servingSizeUnit)) return 100;
  if (Number.isFinite(food.servingSizeGrams) && (food.servingSizeGrams ?? 0) > 0) {
    return Number(food.servingSizeGrams);
  }
  if (
    food.servingSizeUnit?.toLowerCase() === 'g' &&
    Number.isFinite(food.servingSize) &&
    (food.servingSize ?? 0) > 0
  ) {
    return Number(food.servingSize);
  }
  return null;
};

const getEntryMacroBasisLabel = (food?: Food) => {
  if (!food) return 'Per 100 g';
  if (!hasTrueServing(food)) {
    return 'Per 100 g';
  }
  return getFoodBasis(food).label;
};

const resolveOffServing = (product: any) => {
  if (typeof product?.serving_size === 'string') {
    const parsed = parseServingSize(product.serving_size);
    if (parsed) return parsed;
  }
  if (product?.serving_quantity && typeof product?.serving_unit === 'string') {
    const unit = product.serving_unit.toLowerCase();
    if (unit === 'g' || unit === 'ml') {
      const amount = Number(product.serving_quantity);
      if (Number.isFinite(amount) && amount > 0) {
        return {
          amount,
          unit,
          label: `${formatNumberSmart(amount)} ${unit}`,
        };
      }
    }
  }
  return null;
};

const lookupOpenFoodFacts = async (barcode: string): Promise<FoodDraft | null> => {
  // Note: browsers block custom User-Agent headers in fetch requests.
  const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`);
  if (!response.ok) {
    throw new Error('Unable to reach Open Food Facts right now.');
  }
  const data = await response.json();
  if (!data || data.status !== 1 || !data.product) {
    return null;
  }
  const product = data.product;
  const serving = resolveOffServing(product);
  if (!serving) {
    return null;
  }
  const nutriments = product.nutriments || {};
  const asNumber = (value: any) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const kjToKcal = (value: number | null) => (value == null ? null : value / 4.184);

  const energyServing = asNumber(nutriments['energy-kcal_serving']) ?? kjToKcal(asNumber(nutriments['energy-kj_serving']));
  const energy100g = asNumber(nutriments['energy-kcal_100g']) ?? kjToKcal(asNumber(nutriments['energy-kj_100g']));
  const servingFactor = serving.amount / 100;
  const calories = energyServing ?? (energy100g != null ? energy100g * servingFactor : null);

  const proteinServing = asNumber(nutriments['proteins_serving']);
  const protein100g = asNumber(nutriments['proteins_100g']);
  const carbsServing = asNumber(nutriments['carbohydrates_serving']);
  const carbs100g = asNumber(nutriments['carbohydrates_100g']);

  const protein = proteinServing ?? (protein100g != null ? protein100g * servingFactor : null);
  const carbs = carbsServing ?? (carbs100g != null ? carbs100g * servingFactor : null);

  if (calories == null || protein == null || carbs == null) {
    return null;
  }

  const safeCalories = Math.max(0, Math.round(calories));
  const productName =
    product.product_name_en ||
    product.product_name ||
    product.generic_name_en ||
    product.generic_name ||
    'Food item';

  return {
    name: String(productName),
    caloriesPerServing: safeCalories,
    carbsPerServing: roundTo1(Math.max(0, carbs)),
    proteinPerServing: roundTo1(Math.max(0, protein)),
    servingLabel: serving.label,
    servingSize: serving.amount,
    servingSizeUnit: serving.unit,
    servingSizeGrams: serving.unit === 'g' ? serving.amount : undefined,
  };
};

const getUserFoods = async () => {
  if (!state.user) return [] as Food[];
  const foodsRef = collection(db, 'users', state.user.uid, 'foods');
  const foodsSnapshot = await getDocs(query(foodsRef, orderBy('name')));
  const foods: Food[] = foodsSnapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Omit<Food, 'id'>),
  }));
  state.foodCache = foods;
  state.entryFormFoodCacheLoaded = true;
  return foods;
};

const sortFoodsForPicker = (foods: Food[], term: string) => {
  const keyword = term.trim().toLowerCase();
  const matches = foods.filter((food) => {
    if (keyword === '') return food.favorite;
    return food.name.toLowerCase().includes(keyword);
  });
  return matches.sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    const aIndex = a.name.toLowerCase().indexOf(keyword);
    const bIndex = b.name.toLowerCase().indexOf(keyword);
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.name.localeCompare(b.name);
  });
};

const fetchEntriesForDate = async (date: string): Promise<Entry[]> => {
  if (!state.user) return [];
  const entryCol = collection(db, 'users', state.user.uid, 'entries', date, 'items');
  const entriesSnapshot = await getDocs(query(entryCol, orderBy('createdAt')));
  return entriesSnapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Omit<Entry, 'id'>),
  }));
};

const fetchWaterLogsForDate = async (date: string): Promise<WaterLog[]> => {
  if (!state.user) return [];
  const waterCol = collection(db, 'users', state.user.uid, 'waterLogs', date, 'items');
  const logsSnapshot = await getDocs(query(waterCol, orderBy('createdAt')));
  return logsSnapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...(docSnap.data() as Omit<WaterLog, 'id'>),
  }));
};

const fetchUserWaterPreference = async () => {
  if (!state.user) return undefined;
  const userRef = doc(db, 'users', state.user.uid);
  const userSnap = await getDoc(userRef);
  if (!userSnap.exists()) return undefined;
  const data = userSnap.data() as { lastWaterMl?: number };
  if (!Number.isFinite(data.lastWaterMl)) return undefined;
  return Number(data.lastWaterMl);
};

const setUserWaterPreference = async (amountMl: number) => {
  if (!state.user) return;
  const userRef = doc(db, 'users', state.user.uid);
  await setDoc(userRef, { lastWaterMl: amountMl }, { merge: true });
};

const addWaterLogForDate = async (date: string, amountMl: number) => {
  if (!state.user) return;
  const payload = {
    userId: state.user.uid,
    date,
    amountMl,
    createdAt: serverTimestamp(),
  };
  await addDoc(collection(db, 'users', state.user.uid, 'waterLogs', date, 'items'), payload);
};

const removeLatestWaterLogForDate = async (date: string) => {
  if (!state.user) return;
  const waterCol = collection(db, 'users', state.user.uid, 'waterLogs', date, 'items');
  const logsSnapshot = await getDocs(query(waterCol, orderBy('createdAt', 'desc'), limit(1)));
  const latest = logsSnapshot.docs[0];
  if (!latest) return;
  await deleteDoc(doc(db, 'users', state.user.uid, 'waterLogs', date, 'items', latest.id));
};

const sumEntries = (entries: Entry[]) => {
  return entries.reduce(
    (acc, entry) => {
      const calories = entry.servings * entry.caloriesPerServing;
      const carbs = entry.servings * entry.carbsPerServing;
      const protein = entry.servings * entry.proteinPerServing;
      return {
        calories: acc.calories + calories,
        carbs: acc.carbs + carbs,
        protein: acc.protein + protein,
      };
    },
    { calories: 0, carbs: 0, protein: 0 }
  );
};

const sumWaterLogs = (logs: WaterLog[]) => logs.reduce((acc, log) => acc + log.amountMl, 0);

const setAppContent = (html: string) => {
  appEl.innerHTML = html;
};

const renderFooter = () => {
  const footer = document.createElement('footer');
  footer.className = 'app-footer';
  footer.textContent = formatBuildTimestamp(BUILD_TIMESTAMP);
  return footer;
};

const showLoading = (message = 'Loading...') => {
  setAppContent(`<p>${message}</p>`);
  appEl.appendChild(renderFooter());
};

const confirmDialog = (options: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
}) => {
  const { title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'default' } = options;
  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal--confirm">
        <div class="modal__header">
          <h3>${title}</h3>
          <button type="button" class="ghost icon-button" data-close>✕</button>
        </div>
        <div class="modal__body">
          <p class="small-text muted">${message}</p>
        </div>
        <div class="footer-actions modal__actions">
          <button type="button" class="secondary" data-cancel>${cancelLabel}</button>
          <button type="button" class="${tone === 'danger' ? 'danger ghost' : ''}" data-confirm>${confirmLabel}</button>
        </div>
      </div>
    `;
    const cleanup = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(false);
    });
    overlay.querySelector('[data-close]')?.addEventListener('click', () => cleanup(false));
    overlay.querySelector('[data-cancel]')?.addEventListener('click', () => cleanup(false));
    overlay.querySelector('[data-confirm]')?.addEventListener('click', () => cleanup(true));
    document.body.appendChild(overlay);
  });
};

const waterAmountChooser = (amounts: number[]) => {
  return new Promise<number | null>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal--water">
        <div class="modal__header">
          <h3>Quick add water</h3>
          <button type="button" class="ghost icon-button" data-close>✕</button>
        </div>
        <div class="modal__body">
          <div class="water-amount-grid">
            ${amounts.map((amount) => `<button type="button" class="secondary" data-amount="${amount}">${amount} oz</button>`).join('')}
          </div>
        </div>
        <div class="footer-actions modal__actions">
          <button type="button" class="secondary" data-cancel>Cancel</button>
        </div>
      </div>
    `;
    const cleanup = (result: number | null) => {
      overlay.remove();
      resolve(result);
    };
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cleanup(null);
    });
    overlay.querySelector('[data-close]')?.addEventListener('click', () => cleanup(null));
    overlay.querySelector('[data-cancel]')?.addEventListener('click', () => cleanup(null));
    overlay.querySelectorAll<HTMLButtonElement>('[data-amount]').forEach((btn) => {
      btn.addEventListener('click', () => cleanup(Number(btn.dataset.amount)));
    });
    document.body.appendChild(overlay);
  });
};

type BarcodeLookupResult =
  | { status: 'draft'; draft: FoodDraft; sourceLabel: string; preferUsdaBasis?: boolean; isBranded?: boolean }
  | { status: 'not-found' }
  | { status: 'cancelled' };

const createBarcodeScanModal = (options: {
  onLookup: (barcode: string) => Promise<BarcodeLookupResult>;
  onDetected: (
    draft: FoodDraft,
    barcode: string,
    summary: { sourceLabel: string; preferUsdaBasis?: boolean; isBranded?: boolean }
  ) => Promise<void>;
}) => {
  const overlay = document.createElement('div');
  overlay.className = 'scan-overlay';
  const modal = document.createElement('div');
  modal.className = 'scan-modal';
  overlay.appendChild(modal);

  let currentStream: MediaStream | null = null;
  let controls: IScannerControls | undefined;
  let timeoutId: number | null = null;
  let hasDetection = false;
  let escapeHandler: ((event: KeyboardEvent) => void) | null = null;
  const reader = new BrowserMultiFormatReader();

  const stopTracks = () => {
    if (timeoutId) window.clearTimeout(timeoutId);
    timeoutId = null;
    if (controls) {
      controls.stop();
      controls = undefined;
    }
    if (currentStream) {
      currentStream.getTracks().forEach((track) => track.stop());
      currentStream = null;
    }
  };

  const close = () => {
    stopTracks();
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
    overlay.remove();
  };

  const renderContent = (html: string) => {
    modal.innerHTML = html;
    modal.querySelector('#close-scan')?.addEventListener('click', close);
  };

  const renderLookupState = (barcode: string) => {
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
    renderContent(`
      <div class="scan-modal__header">
        <button class="ghost" id="close-scan">Cancel</button>
      </div>
      <div class="scan-modal__body scan-modal__body--lookup">
        <div class="spinner" aria-hidden="true"></div>
        <p class="scan-status">Looking up <strong>${barcode}</strong>...</p>
        <p class="small-text muted">Hold tight while we fetch nutrition details.</p>
      </div>
    `);
  };

  const renderErrorState = (
    message: string,
    allowRetry: boolean,
    allowManualEntry: boolean,
    retryAction: () => void = startScanning
  ) => {
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
    renderContent(`
      <div class="scan-modal__header">
        <button class="ghost" id="close-scan">Cancel</button>
      </div>
      <div class="scan-modal__body">
        <p class="scan-status">${message}</p>
        <div class="footer-actions">
          ${allowRetry ? '<button class="secondary" id="retry-scan">Try again</button>' : ''}
          ${allowManualEntry ? '<button id="enter-barcode">Enter barcode number</button>' : ''}
        </div>
      </div>
    `);
    modal.querySelector('#retry-scan')?.addEventListener('click', () => {
      retryAction();
    });
    modal.querySelector('#enter-barcode')?.addEventListener('click', () => {
      openManualEntry();
    });
  };

  const renderNotFoundState = (tryAgainLabel: string, onTryAgain: () => void) => {
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
    renderContent(`
      <div class="scan-modal__header">
        <button class="ghost" id="close-scan">Cancel</button>
      </div>
      <div class="scan-modal__body">
        <p class="scan-status">We couldn’t find this product by barcode.</p>
        <div class="footer-actions">
          <button class="secondary" id="retry-scan">${tryAgainLabel}</button>
          <button id="close-scan-body">Close</button>
        </div>
      </div>
    `);
    modal.querySelector('#retry-scan')?.addEventListener('click', onTryAgain);
    modal.querySelector('#close-scan-body')?.addEventListener('click', close);
  };

  const handleLookup = async (barcode: string, onNotFound: () => void, onError: () => void) => {
    const normalized = normalizeBarcode(barcode);
    if (!isValidBarcode(normalized)) {
      renderErrorState('Enter a valid 8–14 digit barcode.', true, true);
      return;
    }
    renderLookupState(normalized);
    try {
      const result = await options.onLookup(normalized);
      if (result.status === 'not-found') {
        onNotFound();
        return;
      }
      if (result.status === 'cancelled') {
        close();
        return;
      }
      await options.onDetected(result.draft, normalized, {
        sourceLabel: result.sourceLabel,
        preferUsdaBasis: result.preferUsdaBasis,
        isBranded: result.isBranded,
      });
      close();
    } catch (err) {
      console.error(err);
      onError();
    }
  };

  const openManualEntry = () => {
    stopTracks();
    renderContent(`
      <div class="scan-modal__header">
        <button class="ghost" id="close-scan">Cancel</button>
      </div>
      <div class="scan-modal__body">
        <form id="manual-barcode-form" class="scan-modal__form">
          <div class="field-group">
            <label for="manual-barcode">Barcode (UPC/EAN)</label>
            <input
              id="manual-barcode"
              name="manualBarcode"
              inputmode="numeric"
              autocomplete="off"
              placeholder="Enter 8–14 digits"
            />
            <p class="small-text muted">Digits only. We’ll ignore spaces or dashes.</p>
          </div>
          <p class="error-text is-hidden" id="manual-barcode-error"></p>
          <div class="footer-actions">
            <button type="button" class="secondary" id="back-to-camera">Back to camera</button>
            <button type="submit">Look up</button>
          </div>
        </form>
      </div>
    `);
    const input = modal.querySelector<HTMLInputElement>('#manual-barcode');
    const errorEl = modal.querySelector<HTMLParagraphElement>('#manual-barcode-error');
    const backBtn = modal.querySelector<HTMLButtonElement>('#back-to-camera');
    const form = modal.querySelector<HTMLFormElement>('#manual-barcode-form');
    if (escapeHandler) document.removeEventListener('keydown', escapeHandler);
    escapeHandler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        startScanning();
      }
    };
    document.addEventListener('keydown', escapeHandler);
    input?.addEventListener('input', () => {
      if (!input) return;
      input.value = normalizeBarcode(input.value);
      if (errorEl) errorEl.classList.add('is-hidden');
    });
    backBtn?.addEventListener('click', () => {
      startScanning();
    });
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const rawValue = input?.value ?? '';
      const normalized = normalizeBarcode(rawValue);
      if (!isValidBarcode(normalized)) {
        if (errorEl) {
          errorEl.textContent = 'Enter 8–14 digits to look up a barcode.';
          errorEl.classList.remove('is-hidden');
        }
        input?.focus();
        return;
      }
      await handleLookup(
        normalized,
        () => renderNotFoundState('Try again', openManualEntry),
        () => renderErrorState('Lookup failed. Check your connection and try again.', true, true, openManualEntry)
      );
    });
    input?.focus();
  };

  const startScanning = async () => {
    stopTracks();
    hasDetection = false;
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }
    renderContent(`
      <div class="scan-modal__header">
        <button class="ghost" id="close-scan">Cancel</button>
      </div>
      <div class="scan-modal__body">
        <div class="scan-video">
          <video id="scan-video" autoplay playsinline muted></video>
        </div>
        <p class="small-text muted center">Center the barcode in the frame.</p>
        <div class="footer-actions">
          <button class="secondary" id="enter-barcode">Enter barcode number</button>
        </div>
      </div>
    `);
    modal.querySelector('#enter-barcode')?.addEventListener('click', () => {
      openManualEntry();
    });
    const videoEl = modal.querySelector<HTMLVideoElement>('#scan-video');
    if (!videoEl) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        renderErrorState('Camera access is not supported in this browser.', false, true);
        return;
      }
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      videoEl.srcObject = currentStream;
      await videoEl.play();
      controls = await reader.decodeFromVideoDevice(undefined, videoEl, (result, error) => {
        if (result && !hasDetection) {
          hasDetection = true;
          const text = result.getText();
          stopTracks();
          handleLookup(
            text,
            () => renderNotFoundState('Try scanning again', startScanning),
            () => {
              hasDetection = false;
              renderErrorState('Lookup failed. Check your connection and try again.', true, true);
            }
          );
        }
        if (error && error.name === 'NotFoundException') {
          // ignore continuous loop until a barcode is found
          return;
        }
      });
      timeoutId = window.setTimeout(() => {
        stopTracks();
        renderErrorState('No barcode detected. Try again or enter a barcode number.', true, true);
      }, 25000);
    } catch (err: any) {
      console.error(err);
      renderErrorState('Camera access blocked. Allow camera to scan or enter a barcode number.', false, true);
    }
  };

  document.body.appendChild(overlay);
  startScanning();

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close();
    }
  });

  return { close };
};

const renderLogin = () => {
  setAppContent(`
    <main class="card">
      <h1>Calorie Tracker</h1>
      <p class="small-text">Sign in or create an account to start tracking.</p>
      <form id="login-form" class="form-grid">
        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" required />
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" required minlength="6" />
        </div>
        <button type="submit">Sign in</button>
        <button type="button" class="secondary" id="create-account">Create account</button>
      </form>
      <p id="login-error" class="error-text" role="alert"></p>
    </main>
  `);

  const loginForm = document.querySelector<HTMLFormElement>('#login-form');
  const errorEl = document.querySelector<HTMLParagraphElement>('#login-error');
  const createBtn = document.querySelector<HTMLButtonElement>('#create-account');

  const handleAuth = async (create = false) => {
    if (!loginForm) return;
    const formData = new FormData(loginForm);
    const email = (formData.get('email') as string).trim();
    const password = (formData.get('password') as string).trim();
    try {
      if (create) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      if (errorEl) errorEl.textContent = err?.message ?? 'Unable to authenticate.';
    }
  };

  loginForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleAuth(false);
  });

  createBtn?.addEventListener('click', () => handleAuth(true));

  appEl.appendChild(renderFooter());
};

const renderNav = () => {
  const navActive = (view: 'dashboard' | 'foods' | 'entry') => {
    return state.currentView === view ? 'active' : '';
  };
  const header = document.createElement('header');
  header.className = 'app-header';
  header.innerHTML = `
    <div class="header-main">
      <h1>Calorie Tracker</h1>
      <div class="header-actions">
        <button id="nav-add-entry" class="primary-cta nav-add-entry-button">Add entry</button>
        <div class="menu" id="nav-menu-wrapper">
          <button id="nav-menu-toggle" class="icon-button ghost" aria-haspopup="true" aria-expanded="false">⋯</button>
          <div id="nav-menu" class="menu-popover" role="menu">
            <button id="nav-signout" class="menu-item" role="menuitem">Sign out</button>
          </div>
        </div>
      </div>
    </div>
    <nav class="tabs" aria-label="Primary">
      <button id="nav-dashboard" class="tab ${navActive('dashboard')}">Dashboard</button>
      <button id="nav-foods" class="tab ${navActive('foods')}">Foods</button>
    </nav>
    <button id="nav-add-entry-fab" class="fab-add-entry" aria-label="Add entry">+ Add entry</button>
  `;
  return header;
};

const ensureToastContainer = () => {
  if (document.querySelector('#toast-container')) return;
  const container = document.createElement('div');
  container.id = 'toast-container';
  container.setAttribute('aria-live', 'polite');
  appEl.appendChild(container);
};

const showToast = (options: {
  message: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  durationMs?: number;
}) => {
  const { message, actionLabel, onAction, durationMs = 3500 } = options;
  ensureToastContainer();
  const container = document.querySelector<HTMLDivElement>('#toast-container');
  if (!container) return;
  container.innerHTML = '';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `
    <div class="toast__message">${message}</div>
    ${actionLabel ? `<button class="toast__action" type="button">${actionLabel}</button>` : ''}
  `;
  container.appendChild(toast);
  let timer = window.setTimeout(() => {
    toast.remove();
  }, durationMs);
  if (actionLabel && onAction) {
    const actionButton = toast.querySelector<HTMLButtonElement>('.toast__action');
    actionButton?.addEventListener('click', async () => {
      window.clearTimeout(timer);
      await onAction();
      toast.remove();
    });
  }
};

const buildShell = () => {
  setAppContent('');
  appEl.appendChild(renderNav());
  setNavMenuOpen(false);
  const main = document.createElement('div');
  main.id = 'view-container';
  appEl.appendChild(main);
  ensureToastContainer();
  appEl.appendChild(renderFooter());
  return main;
};

const renderForView = (
  view: View,
  payload?: { date?: string; entryId?: string; prefillName?: string; foodId?: string; returnDate?: string }
) => {
  switch (view) {
    case 'dashboard':
      renderDashboard(payload?.date);
      break;
    case 'foods':
      renderFoods();
      break;
    case 'add-entry':
      renderEntryForm({ date: payload?.date ?? state.selectedDate, entryId: payload?.entryId });
      break;
    case 'edit-entry':
      renderEntryForm({ date: payload?.date ?? state.selectedDate, entryId: payload?.entryId });
      break;
    case 'add-food':
      renderAddFoodView({ prefillName: payload?.prefillName, returnDate: payload?.returnDate, foodId: payload?.foodId });
      break;
  }
};

const setView = (
  view: View,
  payload?: { date?: string; entryId?: string; prefillName?: string; foodId?: string; returnDate?: string }
) => {
  applyViewState(view, { returnDate: payload?.returnDate });
  renderForView(view, payload);
};

const mobileQuery = window.matchMedia('(max-width: 640px)');
const handleMobileChange = () => {
  const prev = state.isMobile;
  state.isMobile = mobileQuery.matches;
  if (state.user && prev !== state.isMobile && state.view === 'foods') {
    renderForView('foods');
  }
};
mobileQuery.addEventListener('change', handleMobileChange);

let navMenuOpen = false;
const setNavMenuOpen = (open: boolean) => {
  navMenuOpen = open;
  const wrapper = document.querySelector<HTMLDivElement>('#nav-menu-wrapper');
  const menu = document.querySelector<HTMLDivElement>('#nav-menu');
  const toggle = document.querySelector<HTMLButtonElement>('#nav-menu-toggle');
  if (wrapper) {
    wrapper.classList.toggle('menu--open', open);
  }
  if (menu) {
    menu.setAttribute('data-open', open ? 'true' : 'false');
  }
  if (toggle) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
};

document.addEventListener('click', (event) => {
  if (!navMenuOpen) return;
  const target = event.target as HTMLElement;
  if (target.closest('#nav-menu') || target.closest('#nav-menu-toggle')) return;
  setNavMenuOpen(false);
});

const renderTotals = (entries: Entry[], waterLogs: WaterLog[], date: string) => {
  const totals = sumEntries(entries);
  const totalWaterMl = sumWaterLogs(waterLogs);
  const totalWaterOz = mlToOz(totalWaterMl);
  return `
    <div class="totals">
      <div class="total-card">
        <div class="total-card__header">
          <div class="total-card__label">Daily totals</div>
        </div>
        <div class="daily-metrics">
          <div class="daily-metric">
            <div class="daily-metric__label">Calories</div>
            <div class="daily-metric__value">${formatNumberSmart(totals.calories)}</div>
            <div class="daily-metric__unit">kcal</div>
          </div>
          <div class="daily-metric">
            <div class="daily-metric__label">Carbs</div>
            <div class="daily-metric__value">${formatNumberSmart(totals.carbs)}</div>
            <div class="daily-metric__unit">g</div>
          </div>
          <div class="daily-metric">
            <div class="daily-metric__label">Protein</div>
            <div class="daily-metric__value">${formatNumberSmart(totals.protein)}</div>
            <div class="daily-metric__unit">g</div>
          </div>
          <div class="daily-metric daily-metric--water">
            <div class="daily-metric__label">Water</div>
            <div class="daily-metric__value" id="water-total">${totalWaterOz}</div>
            <div class="daily-metric__unit">oz</div>
            <div class="daily-metric__actions">
              <button id="add-water" class="ghost button-compact">+ Add water</button>
              <button id="water-chooser" class="ghost icon-button button-compact" aria-label="Choose water amount">
                ▾
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
};

const renderDashboard = async (dateOverride?: string) => {
  applyViewState('dashboard');
  if (dateOverride) {
    state.selectedDate = dateOverride;
  }
  const container = buildShell();
  container.innerHTML = `
    <section class="card stack-card dashboard-card">
      <div class="dashboard-header">
        <h2>Daily dashboard</h2>
        <div class="date-row">
          <button id="prev-day" class="ghost icon-button" aria-label="Previous day">‹</button>
          <button id="date-display" class="date-display" type="button" aria-label="Select date">
            <span class="date-value">${formatDisplayDate(state.selectedDate)}</span>
          </button>
          <button id="next-day" class="ghost icon-button" aria-label="Next day">›</button>
          <input type="date" id="date-picker" class="visually-hidden" value="${state.selectedDate}" />
        </div>
      </div>
      <div id="totals"></div>
    </section>
    <section class="card stack-card dashboard-card">
      <div class="flex space-between">
        <h3>Entries</h3>
        <button id="add-entry">Add entry</button>
      </div>
      <div id="entries-list"></div>
    </section>
  `;

  const updateDate = (newDate: string) => {
    state.selectedDate = newDate;
    setView('dashboard', { date: newDate });
  };

  container.querySelector('#prev-day')?.addEventListener('click', () => {
    updateDate(addDays(state.selectedDate, -1));
  });

  container.querySelector('#next-day')?.addEventListener('click', () => {
    updateDate(addDays(state.selectedDate, 1));
  });

  container.querySelector('#date-display')?.addEventListener('click', () => {
    const picker = container.querySelector<HTMLInputElement>('#date-picker');
    if (!picker) return;
    if ('showPicker' in picker) {
      (picker as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } else {
      picker.focus();
    }
  });

  container.querySelector<HTMLInputElement>('#date-picker')?.addEventListener('change', (e) => {
    const value = (e.target as HTMLInputElement).value;
    updateDate(value || todayStr());
  });

  container.querySelector('#add-entry')?.addEventListener('click', () => {
    state.entryReturnContext = null;
    setView('add-entry', { date: state.selectedDate });
  });

  const entriesList = container.querySelector('#entries-list');
  const totalsEl = container.querySelector('#totals');
  if (!entriesList || !totalsEl) return;
  entriesList.innerHTML = '<p class="small-text">Loading entries...</p>';

  const [entries, waterLogs, lastWaterMl] = await Promise.all([
    fetchEntriesForDate(state.selectedDate),
    fetchWaterLogsForDate(state.selectedDate),
    fetchUserWaterPreference(),
  ]);
  state.lastWaterMl = lastWaterMl ?? state.lastWaterMl;
  totalsEl.innerHTML = renderTotals(entries, waterLogs, state.selectedDate);

  const refreshWaterCard = async () => {
    const latestLogs = await fetchWaterLogsForDate(state.selectedDate);
    const totalWaterMl = sumWaterLogs(latestLogs);
    const totalWaterOz = mlToOz(totalWaterMl);
    const totalEl = totalsEl.querySelector<HTMLDivElement>('#water-total');
    if (totalEl) {
      totalEl.textContent = `${totalWaterOz}`;
    }
  };

  const addWater = async (amountMl: number) => {
    await addWaterLogForDate(state.selectedDate, amountMl);
    await setUserWaterPreference(amountMl);
    state.lastWaterMl = amountMl;
    await refreshWaterCard();
    const amountOz = mlToOz(amountMl);
    const dateForUndo = state.selectedDate;
    showToast({
      message: `Added ${formatNumberSmart(amountOz)} oz`,
      actionLabel: 'Undo',
      onAction: async () => {
        await removeLatestWaterLogForDate(dateForUndo);
        if (state.selectedDate === dateForUndo) {
          await refreshWaterCard();
        }
      },
    });
  };

  totalsEl.querySelector<HTMLButtonElement>('#add-water')?.addEventListener('click', async () => {
    const defaultMl = state.lastWaterMl ?? ozToMl(8);
    await addWater(defaultMl);
  });

  totalsEl.querySelector<HTMLButtonElement>('#water-chooser')?.addEventListener('click', async () => {
    const amount = await waterAmountChooser(WATER_PRESETS_OZ);
    if (!amount) return;
    await addWater(ozToMl(amount));
  });

  if (!entries.length) {
    entriesList.innerHTML = '<p class="small-text">No entries yet for this date.</p>';
  } else {
    const rows = entries
      .map((entry) => {
        const calories = entry.servings * entry.caloriesPerServing;
        const carbs = entry.servings * entry.carbsPerServing;
        const protein = entry.servings * entry.proteinPerServing;
        return `
        <li class="entry-card">
          <div class="entry-main">
            <div>
              <div class="entry-title">${entry.foodName}</div>
              <div class="small-text muted">${formatNumberSmart(entry.servings)} serving(s)</div>
            </div>
            ${renderMacroSummary({ calories, carbs, protein, variant: 'compact' })}
          </div>
          <div class="entry-actions">
            <button class="secondary" data-edit="${entry.id}">Edit</button>
            <button class="ghost icon-button" data-delete="${entry.id}" aria-label="Delete entry">🗑</button>
          </div>
        </li>
      `;
      })
      .join('');

    entriesList.innerHTML = `<ul class="entry-list">${rows}</ul>`;

    entriesList.querySelectorAll<HTMLButtonElement>('button[data-edit]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const entryId = btn.dataset.edit;
        if (!entryId) return;
        setView('add-entry', { date: state.selectedDate, entryId });
      })
    );

    entriesList.querySelectorAll<HTMLButtonElement>('button[data-delete]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const entryId = btn.dataset.delete;
        if (!entryId || !state.user) return;
        const confirmed = await confirmDialog({
          title: 'Delete entry?',
          message: 'This entry will be removed from your daily log.',
          confirmLabel: 'Delete entry',
          tone: 'danger',
        });
        if (!confirmed) return;
        const entryRef = doc(db, 'users', state.user.uid, 'entries', state.selectedDate, 'items', entryId);
        await deleteDoc(entryRef);
        setView('dashboard');
      })
    );
  }
};

const upsertFood = async (food: Partial<Food> & { name: string }) => {
  if (!state.user) throw new Error('No user');
  const payload: Partial<Food> & { name: string; createdAt: ReturnType<typeof serverTimestamp> } = {
    caloriesPerServing: roundTo2(Number(food.caloriesPerServing ?? 0)),
    carbsPerServing: roundTo2(Number(food.carbsPerServing ?? 0)),
    proteinPerServing: roundTo2(Number(food.proteinPerServing ?? 0)),
    favorite: Boolean(food.favorite),
    name: food.name.trim(),
    createdAt: serverTimestamp(),
  };
  if (food.barcode) {
    payload.barcode = normalizeBarcode(food.barcode);
  }
  if (Number.isFinite(food.servingSize) && (food.servingSize ?? 0) > 0) {
    payload.servingSize = roundTo2(Number(food.servingSize));
  }
  if (food.servingSizeUnit) {
    payload.servingSizeUnit = String(food.servingSizeUnit);
  }
  if (Number.isFinite(food.servingSizeGrams) && (food.servingSizeGrams ?? 0) > 0) {
    payload.servingSizeGrams = roundTo2(Number(food.servingSizeGrams));
  }

  if (food.id) {
    const foodRef = doc(db, 'users', state.user.uid, 'foods', food.id);
    await setDoc(foodRef, payload, { merge: true });
    state.foodCache = state.foodCache.map((f) => (f.id === food.id ? { ...f, ...payload } : f));
    return food.id;
  }
  const newDoc = await addDoc(collection(db, 'users', state.user.uid, 'foods'), payload);
  const newFood: Food = {
    id: newDoc.id,
    caloriesPerServing: payload.caloriesPerServing,
    carbsPerServing: payload.carbsPerServing,
    proteinPerServing: payload.proteinPerServing,
    favorite: payload.favorite,
    name: payload.name,
    barcode: payload.barcode,
    servingSize: payload.servingSize,
    servingSizeUnit: payload.servingSizeUnit,
    servingSizeGrams: payload.servingSizeGrams,
  };
  state.foodCache.push(newFood);
  return newDoc.id;
};

const renderFoodForm = (options: {
  onSave: (food: Food) => void;
  food?: Food;
  container: HTMLElement;
  prefillName?: string;
}) => {
  const { onSave, food, container, prefillName } = options;
  let caloriesVal = food?.caloriesPerServing ?? 0;
  let carbsVal = food?.carbsPerServing ?? 0;
  let proteinVal = food?.proteinPerServing ?? 0;
  let servingLabel: string | undefined;
  let servingSize = food?.servingSize;
  let servingSizeUnit = food?.servingSizeUnit;
  let servingSizeGrams = food?.servingSizeGrams ?? (food?.servingSizeUnit === 'g' ? food?.servingSize : undefined);
  if (!servingSizeGrams && food && !isPer100gUnit(food.servingSizeUnit)) {
    servingSizeGrams = 100;
  }
  let previousDraft: FoodDraft | null = null;
  let initialDraft: FoodDraft | null = null;
  let appliedSummary: { draft: FoodDraft; isBranded: boolean } | null = null;
  let addFoodMode: 'discovery' | 'summary' | 'edit' = food ? 'edit' : 'discovery';
  let currentBarcode = food?.barcode ? normalizeBarcode(food.barcode) : undefined;
  let previousBarcode: string | undefined;
  const scanSupported = Boolean(navigator.mediaDevices?.getUserMedia);
  const form = document.createElement('form');
  form.className = 'form-grid form-grid--stack add-food-form';
  form.innerHTML = `
    <div class="form-section find-section">
      <div class="section-heading">
        <p class="section-eyebrow">Find</p>
        <h3>Find your food</h3>
      </div>
      <div class="find-actions">
        <div class="find-card" id="lookup-card">
          <div class="field-group">
            <label for="lookup-term">Search USDA FoodData Central</label>
            <div class="lookup-input-row">
              <input id="lookup-term" name="lookupTerm" placeholder="Search foods by name" value="${prefillName ?? ''}" />
              <button type="button" id="lookup-nutrition" class="secondary">Lookup</button>
            </div>
          </div>
          <div id="lookup-error" class="error-text"></div>
        </div>
        ${
          scanSupported
            ? `
            <div class="find-card" id="scan-card">
              <div class="field-group">
                <label>Scan barcode to fill details</label>
                <p class="small-text muted">Use your camera to find packaged foods and autofill fields.</p>
                <button type="button" id="scan-barcode" class="secondary">Scan barcode</button>
              </div>
              <div id="barcode-status" class="small-text muted"></div>
            </div>
          `
            : ''
        }
      </div>
      <div class="find-actions-footer">
        <button type="button" id="enter-manual" class="secondary">Enter values manually</button>
      </div>
    </div>
    <div class="form-section summary-section">
      <div class="summary-card" id="food-summary">
        <div class="summary-card__header">
          <div>
            <div class="summary-card__title" id="summary-name"></div>
            <div class="summary-card__meta">
              <span class="badge badge--branded is-hidden" id="summary-branded">Branded</span>
              <span class="summary-card__basis" id="summary-basis"></span>
            </div>
          </div>
        </div>
        <div id="summary-macros"></div>
      </div>
      <div class="summary-actions">
        <button type="submit" id="summary-save">Save food</button>
        <button type="button" class="secondary" id="summary-edit">Edit values</button>
      </div>
    </div>
    <div class="form-section manual-section">
      <div class="section-heading">
        <p class="section-eyebrow">Edit values</p>
        <h3>Edit values</h3>
        <p class="small-text muted">Adjust the values before saving.</p>
      </div>
      <div class="manual-card">
        <div class="field-group">
          <label for="food-name">Name</label>
          <input id="food-name" name="name" required value="${food?.name ?? prefillName ?? ''}" />
        </div>
        <div class="field-group">
          <label for="serving-grams" id="serving-grams-label">Serving size (g)</label>
          <input
            id="serving-grams"
            name="servingSizeGrams"
            type="text"
            inputmode="decimal"
            required
            placeholder="e.g., 45"
            value="${servingSizeGrams ? formatNumberSmart(servingSizeGrams) : ''}"
          />
          <p class="small-text muted" id="serving-grams-help"></p>
        </div>
        <div class="macro-grid">
          <div>
            <label for="calories" id="calories-label">Calories per serving</label>
            <input id="calories" name="caloriesPerServing" type="text" inputmode="decimal" required value="${formatNumberSmart(
              caloriesVal
            )}" />
          </div>
          <div>
            <label for="carbs" id="carbs-label">Carbs (g) per serving</label>
            <input id="carbs" name="carbsPerServing" type="text" inputmode="decimal" required value="${formatNumberSmart(
              carbsVal
            )}" />
          </div>
          <div>
            <label for="protein" id="protein-label">Protein (g) per serving</label>
            <input id="protein" name="proteinPerServing" type="text" inputmode="decimal" required value="${formatNumberSmart(
              proteinVal
            )}" />
          </div>
        </div>
        <div>
          <label for="favorite">Favorite</label>
          <select id="favorite" name="favorite">
            <option value="false" ${!food?.favorite ? 'selected' : ''}>No</option>
            <option value="true" ${food?.favorite ? 'selected' : ''}>Yes</option>
          </select>
        </div>
      </div>
      <div class="footer-actions">
        <button type="submit">Save food</button>
      </div>
    </div>
  `;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const gramsValue = parseDecimal2(String(formData.get('servingSizeGrams') || ''), 0.01);
    if (isPer100gUnit(servingSizeUnit)) {
      servingSizeGrams = 100;
      servingSize = 100;
      servingSizeUnit = PER_100G_UNIT;
    } else {
      servingSizeGrams = gramsValue;
      servingSize = gramsValue;
      servingSizeUnit = 'g';
    }
    const payload = {
      id: food?.id,
      name: String(formData.get('name') || '').trim(),
      caloriesPerServing: caloriesVal,
      carbsPerServing: carbsVal,
      proteinPerServing: proteinVal,
      favorite: formData.get('favorite') === 'true',
      barcode: currentBarcode,
      servingSize,
      servingSizeUnit,
      servingSizeGrams,
    } as Food;
    const id = await upsertFood(payload);
    const savedFood = { ...payload, id } as Food;
    onSave(savedFood);
  });

  const nameInput = form.querySelector<HTMLInputElement>('#food-name');
  const lookupInput = form.querySelector<HTMLInputElement>('#lookup-term');
  const servingGramsInput = form.querySelector<HTMLInputElement>('#serving-grams');
  const caloriesInput = form.querySelector<HTMLInputElement>('#calories');
  const carbsInput = form.querySelector<HTMLInputElement>('#carbs');
  const proteinInput = form.querySelector<HTMLInputElement>('#protein');
  const servingGramsLabel = form.querySelector<HTMLLabelElement>('#serving-grams-label');
  const servingGramsHelp = form.querySelector<HTMLParagraphElement>('#serving-grams-help');
  const caloriesLabelEl = form.querySelector<HTMLLabelElement>('#calories-label');
  const carbsLabelEl = form.querySelector<HTMLLabelElement>('#carbs-label');
  const proteinLabelEl = form.querySelector<HTMLLabelElement>('#protein-label');
  const lookupBtn = form.querySelector<HTMLButtonElement>('#lookup-nutrition');
  const scanBtn = form.querySelector<HTMLButtonElement>('#scan-barcode');
  const lookupCard = form.querySelector<HTMLDivElement>('#lookup-card');
  const lookupError = form.querySelector<HTMLDivElement>('#lookup-error');
  const barcodeStatus = form.querySelector<HTMLDivElement>('#barcode-status');
  const enterManualButton = form.querySelector<HTMLButtonElement>('#enter-manual');
  const summaryName = form.querySelector<HTMLDivElement>('#summary-name');
  const summaryBasis = form.querySelector<HTMLSpanElement>('#summary-basis');
  const summaryMacros = form.querySelector<HTMLDivElement>('#summary-macros');
  const summaryBranded = form.querySelector<HTMLSpanElement>('#summary-branded');
  const summaryEditButton = form.querySelector<HTMLButtonElement>('#summary-edit');
  let lookupResults: HTMLDivElement | null = null;

  const updateServingContext = (draft?: Partial<FoodDraft>) => {
    if (draft && 'servingLabel' in draft) servingLabel = draft.servingLabel;
    if (draft && 'servingSize' in draft) servingSize = draft.servingSize;
    if (draft && 'servingSizeUnit' in draft) servingSizeUnit = draft.servingSizeUnit;
    if (draft && 'servingSizeGrams' in draft) servingSizeGrams = draft.servingSizeGrams;
    const anchor = resolveServingAnchor({
      servingSizeGrams,
      servingSize,
      servingSizeUnit,
      servingLabel,
    });
    servingLabel = anchor?.label;
  };

  const updateFoodFormBasisLabels = () => {
    const isPer100g = isPer100gUnit(servingSizeUnit);
    if (servingGramsLabel) {
      servingGramsLabel.textContent = isPer100g ? 'Nutrition basis (g)' : 'Serving size (g)';
    }
    if (servingGramsHelp) {
      servingGramsHelp.textContent = isPer100g ? 'Nutrition is stored per 100 g (no serving size).' : '';
    }
    const perLabel = isPer100g ? 'per 100 g' : 'per serving';
    if (caloriesLabelEl) caloriesLabelEl.textContent = `Calories ${perLabel}`;
    if (carbsLabelEl) carbsLabelEl.textContent = `Carbs (g) ${perLabel}`;
    if (proteinLabelEl) proteinLabelEl.textContent = `Protein (g) ${perLabel}`;
    if (servingGramsInput) {
      servingGramsInput.readOnly = isPer100g;
    }
  };

  updateServingContext({ servingLabel, servingSize, servingSizeUnit, servingSizeGrams });
  updateFoodFormBasisLabels();

  const ensureLookupResults = () => {
    if (lookupResults) return lookupResults;
    if (!lookupCard) return null;
    const results = document.createElement('div');
    results.id = 'lookup-results';
    results.className = 'lookup-results';
    results.setAttribute('aria-live', 'polite');
    lookupCard.appendChild(results);
    lookupResults = results;
    return results;
  };

  const removeLookupResults = () => {
    if (!lookupResults) return;
    lookupResults.remove();
    lookupResults = null;
  };

  const setBarcodeStatus = (message: string) => {
    if (barcodeStatus) barcodeStatus.textContent = message;
  };

  const setAddFoodMode = (mode: 'discovery' | 'summary' | 'edit', options?: { focus?: boolean }) => {
    addFoodMode = mode;
    form.classList.toggle('add-food--discovery', mode === 'discovery');
    form.classList.toggle('add-food--summary', mode === 'summary');
    form.classList.toggle('add-food--edit', mode === 'edit');
    if (mode === 'edit' && options?.focus) {
      nameInput?.focus();
    }
  };

  const getSummaryBasisLabel = (draft: FoodDraft) => {
    if (!draft.servingSizeGrams || !Number.isFinite(draft.servingSizeGrams) || draft.servingSizeGrams <= 0) {
      return 'Per 100 g';
    }
    const isPer100g = isPer100gUnit(draft.servingSizeUnit);
    if (isPer100g) {
      return 'Per 100 g';
    }
    return `Per serving: ${formatNumberSmart(draft.servingSizeGrams)} g`;
  };

  const setSummaryCard = (draft: FoodDraft | null, meta?: { isBranded?: boolean }) => {
    appliedSummary = draft ? { draft, isBranded: meta?.isBranded ?? false } : null;
    if (!summaryName || !summaryBasis || !summaryMacros || !summaryBranded) return;
    if (!draft) {
      summaryName.textContent = '';
      summaryBasis.textContent = '';
      summaryMacros.innerHTML = '';
      summaryBranded.classList.add('is-hidden');
      return;
    }
    summaryName.textContent = draft.name;
    summaryBasis.textContent = getSummaryBasisLabel(draft);
    summaryMacros.innerHTML = renderHeroMetrics({
      calories: draft.caloriesPerServing,
      carbs: draft.carbsPerServing,
      protein: draft.proteinPerServing,
      className: 'hero-metrics--compact',
    });
    summaryBranded.classList.toggle('is-hidden', !appliedSummary?.isBranded);
  };

  const captureCurrentDraft = (): FoodDraft => ({
    name: nameInput?.value ?? '',
    caloriesPerServing: caloriesVal,
    carbsPerServing: carbsVal,
    proteinPerServing: proteinVal,
    servingLabel,
    servingSize,
    servingSizeUnit,
    servingSizeGrams,
  });

  initialDraft = captureCurrentDraft();
  setAddFoodMode(addFoodMode);

  const restoreDraft = (draft: FoodDraft) => {
    caloriesVal = draft.caloriesPerServing;
    carbsVal = draft.carbsPerServing;
    proteinVal = draft.proteinPerServing;
    if (nameInput) nameInput.value = draft.name;
    if (caloriesInput) caloriesInput.value = formatNumberSmart(caloriesVal);
    if (carbsInput) carbsInput.value = formatNumberSmart(carbsVal);
    if (proteinInput) proteinInput.value = formatNumberSmart(proteinVal);
    if (servingGramsInput) {
      const gramsValue = draft.servingSizeGrams ?? servingSizeGrams;
      servingGramsInput.value = gramsValue ? formatNumberSmart(gramsValue) : '';
    }
    updateServingContext({
      servingLabel: draft.servingLabel,
      servingSize: draft.servingSize,
      servingSizeUnit: draft.servingSizeUnit,
      servingSizeGrams: draft.servingSizeGrams,
    });
    updateFoodFormBasisLabels();
  };

  const confirmOverwriteIfNeeded = async (sourceLabel: string) => {
    if (!food) return true;
    const hasData =
      Boolean(nameInput?.value.trim()) ||
      Boolean(caloriesInput?.value.trim()) ||
      Boolean(carbsInput?.value.trim()) ||
      Boolean(proteinInput?.value.trim());
    if (!hasData) return true;
    return confirmDialog({
      title: `Overwrite current details?`,
      message: `This will replace the nutrition values with the ${sourceLabel} result.`,
      confirmLabel: 'Overwrite',
      cancelLabel: 'Cancel',
    });
  };

  const createUsdaDraftFromResult = (result: UsdaFoodResult): FoodDraft => {
    const anchor = resolveServingAnchor({
      servingSize: result.servingSize,
      servingSizeUnit: result.servingSizeUnit,
    });
    const servingFactor = anchor ? anchor.amount / 100 : 1;
    const calories = result.calories == null ? 0 : Math.round(result.calories * servingFactor);
    const carbs = result.carbs == null ? 0 : roundTo1(result.carbs * servingFactor);
    const protein = result.protein == null ? 0 : roundTo1(result.protein * servingFactor);
    return {
      name: result.description,
      caloriesPerServing: calories,
      carbsPerServing: carbs,
      proteinPerServing: protein,
      servingLabel: anchor?.label,
      servingSize: anchor ? anchor.amount : 100,
      servingSizeUnit: anchor ? 'g' : PER_100G_UNIT,
      servingSizeGrams: anchor ? anchor.amount : 100,
    };
  };

  const applyDraftFromLookup = (draft: FoodDraft, meta?: { isBranded?: boolean }) => {
    previousDraft = captureCurrentDraft();
    previousBarcode = currentBarcode;
    restoreDraft(draft);
    setSummaryCard(draft, { isBranded: meta?.isBranded });
    removeLookupResults();
    setAddFoodMode('summary');
  };

  const applyDraftFromBarcode = (
    draft: FoodDraft,
    barcode: string | undefined,
    summary: { sourceLabel: string; preferUsdaBasis?: boolean; isBranded?: boolean }
  ) => {
    previousDraft = captureCurrentDraft();
    previousBarcode = currentBarcode;
    currentBarcode = barcode;
    caloriesVal = draft.caloriesPerServing;
    carbsVal = draft.carbsPerServing;
    proteinVal = draft.proteinPerServing;
    servingSize = draft.servingSize;
    servingSizeUnit = draft.servingSizeUnit;
    servingSizeGrams = draft.servingSizeGrams;
    if (nameInput) nameInput.value = draft.name;
    if (caloriesInput) caloriesInput.value = formatNumberSmart(caloriesVal);
    if (carbsInput) carbsInput.value = formatNumberSmart(carbsVal);
    if (proteinInput) proteinInput.value = formatNumberSmart(proteinVal);
    updateServingContext({
      servingLabel: draft.servingLabel,
      servingSize: draft.servingSize,
      servingSizeUnit: draft.servingSizeUnit,
      servingSizeGrams: draft.servingSizeGrams,
    });
    updateFoodFormBasisLabels();
    if (servingGramsInput) {
      const gramsValue = draft.servingSizeGrams ?? servingSizeGrams;
      servingGramsInput.value = gramsValue ? formatNumberSmart(gramsValue) : '';
    }
    setBarcodeStatus(
      barcode
        ? `Found ${barcode}${draft.servingLabel ? ` • ${draft.servingLabel}` : ''}. Review and save.`
        : ''
    );
    setSummaryCard(draft, { isBranded: summary.isBranded });
    removeLookupResults();
    setAddFoodMode('summary');
  };

  const openBarcodeSelectionModal = <T,>(options: {
    title: string;
    description?: string;
    choices: { id: string; title: string; subtitle?: string; detail?: string; value: T }[];
  }): Promise<T | null> =>
    new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal">
          <div class="modal__header">
            <h3>${options.title}</h3>
            <button type="button" class="ghost icon-button" data-close>✕</button>
          </div>
          <div class="modal__body">
            ${options.description ? `<p class="small-text muted">${options.description}</p>` : ''}
            <div class="barcode-choice-list">
              ${options.choices
                .map(
                  (choice) => `
                <button type="button" class="usda-result" data-choice="${choice.id}">
                  <div class="usda-result__header">
                    <div class="usda-result__title">${choice.title}</div>
                  </div>
                  ${choice.subtitle ? `<div class="small-text muted">${choice.subtitle}</div>` : ''}
                  ${choice.detail ? `<div class="small-text">${choice.detail}</div>` : ''}
                </button>
              `
                )
                .join('')}
            </div>
          </div>
          <div class="footer-actions modal__actions">
            <button type="button" class="secondary" data-cancel>Cancel</button>
          </div>
        </div>
      `;
      const cleanup = (value: T | null) => {
        overlay.remove();
        resolve(value);
      };
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) cleanup(null);
      });
      overlay.querySelector('[data-close]')?.addEventListener('click', () => cleanup(null));
      overlay.querySelector('[data-cancel]')?.addEventListener('click', () => cleanup(null));
      overlay.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.choice;
          const match = options.choices.find((choice) => choice.id === id);
          cleanup(match ? match.value : null);
        });
      });
      document.body.appendChild(overlay);
    });

  const createDraftFromFood = (saved: Food): FoodDraft => {
    const anchor = resolveServingAnchor({
      servingSizeGrams: saved.servingSizeGrams,
      servingSize: saved.servingSize,
      servingSizeUnit: saved.servingSizeUnit,
    });
    return {
      name: saved.name,
      caloriesPerServing: saved.caloriesPerServing,
      carbsPerServing: saved.carbsPerServing,
      proteinPerServing: saved.proteinPerServing,
      servingLabel: anchor?.label,
      servingSize: saved.servingSize,
      servingSizeUnit: saved.servingSizeUnit,
      servingSizeGrams: saved.servingSizeGrams,
    };
  };

  const formatUsdaServing = (result: UsdaFoodResult) => {
    if (!result.servingSize || !result.servingSizeUnit) return undefined;
    return `${formatNumberSmart(result.servingSize)} ${result.servingSizeUnit}`;
  };

  const lookupBarcode = async (barcode: string): Promise<BarcodeLookupResult> => {
    if (!state.entryFormFoodCacheLoaded) {
      await getUserFoods();
    }
    const normalized = normalizeBarcode(barcode);
    const savedMatches = state.foodCache.filter(
      (foodItem) => normalizeBarcode(foodItem.barcode ?? '') === normalized
    );
    if (savedMatches.length === 1) {
      return {
        status: 'draft',
        draft: createDraftFromFood(savedMatches[0]),
        sourceLabel: 'Source: Saved food',
        isBranded: false,
      };
    }
    if (savedMatches.length > 1) {
      const chosen = await openBarcodeSelectionModal<Food>({
        title: 'Choose a saved food',
        description: 'We found multiple saved foods with this barcode.',
        choices: savedMatches.map((foodItem) => ({
          id: foodItem.id,
          title: foodItem.name,
          subtitle: 'Saved food',
          value: foodItem,
        })),
      });
      if (!chosen) return { status: 'cancelled' };
      return {
        status: 'draft',
        draft: createDraftFromFood(chosen),
        sourceLabel: 'Source: Saved food',
        isBranded: false,
      };
    }

    const offDraft = await lookupOpenFoodFacts(normalized);
    if (offDraft) {
      return { status: 'draft', draft: offDraft, sourceLabel: 'Source: Open Food Facts', isBranded: false };
    }

    const usdaResults = await searchUsdaFoodsByBarcode(normalized);
    if (!usdaResults.length) {
      return { status: 'not-found' };
    }
    const gtinMatches = usdaResults.filter((result) => normalizeBarcode(result.gtinUpc ?? '') === normalized);
    const candidates = gtinMatches.length ? gtinMatches : usdaResults;
    let selected: UsdaFoodResult | null = candidates[0];
    if (candidates.length > 1) {
      selected = await openBarcodeSelectionModal<UsdaFoodResult>({
        title: 'Choose a product',
        description: 'We found multiple barcode matches. Pick the one that fits.',
        choices: candidates.map((result) => ({
          id: result.id,
          title: result.description,
          subtitle: result.brandOwner,
          detail: formatUsdaServing(result),
          value: result,
        })),
      });
    }
    if (!selected) {
      return { status: 'cancelled' };
    }
    const draft = createUsdaDraftFromResult(selected);
    return {
      status: 'draft',
      draft,
      sourceLabel: 'Source: USDA FoodData Central',
      preferUsdaBasis: true,
      isBranded: selected.dataType?.toLowerCase() === 'branded',
    };
  };

  const attachDecimalInput = (
    input: HTMLInputElement | null,
    min: number,
    onChange: (value: number) => void
  ) => {
    if (!input) return;
    input.addEventListener('input', () => {
      const parsed = parseDecimal2(input.value, min);
      onChange(parsed);
    });
    input.addEventListener('blur', () => {
      const parsed = parseDecimal2(input.value, min);
      input.value = formatNumberSmart(parsed);
      onChange(parsed);
    });
  };

  attachDecimalInput(caloriesInput, 0, (value) => {
    caloriesVal = value;
  });
  attachDecimalInput(carbsInput, 0, (value) => {
    carbsVal = value;
  });
  attachDecimalInput(proteinInput, 0, (value) => {
    proteinVal = value;
  });
  attachDecimalInput(servingGramsInput, 0.01, (value) => {
    servingSizeGrams = value;
    servingSize = value;
    servingSizeUnit = 'g';
    updateServingContext({ servingSizeGrams: value });
    updateFoodFormBasisLabels();
  });

  attachSelectAllOnFocus(servingGramsInput);
  attachSelectAllOnFocus(caloriesInput);
  attachSelectAllOnFocus(carbsInput);
  attachSelectAllOnFocus(proteinInput);

  const renderLookupResults = (results: UsdaFoodResult[]) => {
    const resultsEl = ensureLookupResults();
    if (!resultsEl) return;
    resultsEl.innerHTML = '';
    if (!results.length) {
      resultsEl.innerHTML = '<div class="small-text muted lookup-empty">No results found.</div>';
      return;
    }
    const normalizeText = (value?: string | null) => (value ?? '').trim();
    const query = normalizeText(state.usdaSearchTerm).toLowerCase();
    const isQueryMatch = (value: string) => Boolean(value) && value.toLowerCase() === query;
    const getUsdaTitle = (result: UsdaFoodResult) => {
      const description = normalizeText(result.description);
      const brandName = normalizeText(result.brandName);
      const brandOwner = normalizeText(result.brandOwner);
      const foodCategory = normalizeText(result.brandedFoodCategory ?? result.foodCategory);
      const dataType = normalizeText(result.dataType);
      const isBranded = result.dataType?.toLowerCase() === 'branded';
      const hasAlternative = Boolean(brandName || brandOwner || foodCategory);
      if (description && (!isQueryMatch(description) || !hasAlternative)) {
        return description;
      }
      if (isBranded && description) {
        if (brandName) return `${brandName} ${description}`.trim();
        if (brandOwner) return `${brandOwner} ${description}`.trim();
      }
      if (brandName) return brandName;
      if (brandOwner) return brandOwner;
      if (foodCategory) return foodCategory;
      if (description) return description;
      if (dataType) return `${dataType} food`;
      return 'Food';
    };
    const formatMacroValue = (value: number | null | undefined) =>
      Number.isFinite(value) ? formatNumberSmart(value) : '—';
    const getUsdaMacrosLine = (result: UsdaFoodResult) => {
      const calories =
        Number.isFinite(result.labelCalories) && result.labelCalories != null
          ? result.labelCalories
          : result.calories;
      const protein = result.protein;
      const carbs = result.carbs;
      return `${formatMacroValue(calories)} kcal • ${formatMacroValue(protein)}g protein • ${formatMacroValue(carbs)}g carbs`;
    };
    results.forEach((result) => {
      const isBranded = result.dataType?.toLowerCase() === 'branded';
      const title = getUsdaTitle(result);
      const macrosLine = getUsdaMacrosLine(result);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'usda-result';
      btn.innerHTML = `
        <div class="usda-result__title-row">
          <div class="usda-result__title">${title}</div>
          ${isBranded ? `<span class="badge badge--branded usda-result__badge">Branded</span>` : ''}
        </div>
        <div class="usda-result__macros">${macrosLine}</div>`;
      btn.addEventListener('click', async () => {
        const draft = createUsdaDraftFromResult(result);
        draft.name = title;
        const confirmed = await confirmOverwriteIfNeeded('USDA lookup');
        if (!confirmed) return;
        applyDraftFromLookup(draft, { isBranded });
        setBarcodeStatus('');
      });
      resultsEl.appendChild(btn);
    });
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const restoreUsdaSearchState = () => {
    if (!lookupInput || !state.usdaSearchHasSearched) return;
    lookupInput.value = state.usdaSearchTerm;
    renderLookupResults(state.usdaSearchResults);
  };

  lookupBtn?.addEventListener('click', async () => {
    if (!lookupInput || !lookupError || !lookupBtn) return;
    const term = lookupInput.value.trim();
    lookupError.textContent = '';
    removeLookupResults();
    if (!term) {
      lookupError.textContent = 'Enter a food name to search.';
      return;
    }
    if (!USDA_API_KEY) {
      lookupError.textContent = 'USDA API key missing. Add VITE_USDA_API_KEY to your .env.';
      return;
    }
    lookupBtn.disabled = true;
    const originalText = lookupBtn.textContent;
    lookupBtn.textContent = 'Looking up...';
    try {
      const results = await searchUsdaFoods(term);
      state.usdaSearchTerm = term;
      state.usdaSearchResults = results;
      state.usdaSearchHasSearched = true;
      renderLookupResults(results);
    } catch (err: any) {
      lookupError.textContent = err?.message ?? 'Lookup failed. Try again later.';
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = originalText;
    }
  });

  scanBtn?.addEventListener('click', () => {
    createBarcodeScanModal({
      onLookup: async (barcode) => lookupBarcode(barcode),
      onDetected: async (draft, barcode, summary) => {
        const confirmed = await confirmOverwriteIfNeeded('barcode scan');
        if (!confirmed) return;
        applyDraftFromBarcode(draft, barcode, summary);
      },
    });
  });

  enterManualButton?.addEventListener('click', () => {
    setSummaryCard(null);
    setAddFoodMode('edit', { focus: true });
  });

  summaryEditButton?.addEventListener('click', () => {
    setAddFoodMode('edit', { focus: true });
  });

  const handleBack = () => {
    if (state.usdaSearchHasSearched && addFoodMode !== 'discovery') {
      if (previousDraft) {
        restoreDraft(previousDraft);
      } else if (initialDraft) {
        restoreDraft(initialDraft);
      }
      currentBarcode = previousBarcode;
      setSummaryCard(null);
      setBarcodeStatus('');
      setAddFoodMode('discovery');
      restoreUsdaSearchState();
      return true;
    }
    return false;
  };

  container.innerHTML = '';
  container.appendChild(form);
  return { handleBack };
};

const renderAddFoodView = async (options?: { prefillName?: string; returnDate?: string; foodId?: string }) => {
  applyViewState('add-food', { returnDate: options?.returnDate });
  state.pendingEntryFoodName = options?.prefillName;
  state.usdaSearchTerm = '';
  state.usdaSearchResults = [];
  state.usdaSearchHasSearched = false;
  if (!state.entryFormFoodCacheLoaded) {
    await getUserFoods();
  }
  const editingFood = options?.foodId ? state.foodCache.find((f) => f.id === options.foodId) : undefined;
  const heading = editingFood ? 'Edit food' : 'Add food';
  const container = buildShell();
  container.innerHTML = `
    <section class="card stack-card">
      <div class="compact-header back-row">
        <button id="back-from-food" class="ghost back-link">← Back</button>
        <div>
          <h2>${heading}</h2>
          ${
            editingFood
              ? `<p class="small-text muted">You’re editing this food. Changes won’t affect past entries.</p>`
              : ''
          }
        </div>
      </div>
      <div id="add-food-form"></div>
    </section>
  `;

  const goBack = () => {
    state.pendingEntryFoodName = undefined;
    if (options?.returnDate) {
      setView('add-entry', { date: options.returnDate });
      return;
    }
    setView('foods');
  };

  const backButton = container.querySelector('#back-from-food');

  const host = container.querySelector<HTMLDivElement>('#add-food-form');
  if (!host) return;

  const { handleBack } = renderFoodForm({
    container: host,
    prefillName: options?.prefillName ?? state.pendingEntryFoodName,
    food: editingFood,
    onSave: (food) => {
      state.prefillFoodId = options?.returnDate ? food.id : undefined;
      state.entryReturnContext = options?.returnDate ? { date: options.returnDate } : state.entryReturnContext;
      if (!state.foodCache.find((f) => f.id === food.id)) {
        state.foodCache.push(food);
      } else {
        state.foodCache = state.foodCache.map((f) => (f.id === food.id ? food : f));
      }
      state.pendingEntryFoodName = undefined;
      if (options?.returnDate) {
        setView('add-entry', { date: options.returnDate });
      } else {
        setView('foods');
      }
    },
  });

  backButton?.addEventListener('click', () => {
    if (handleBack()) return;
    goBack();
  });
};

const renderFoods = async () => {
  applyViewState('foods');
  const container = buildShell();
  container.innerHTML = `
    <section class="card stack-card">
      <div class="compact-header">
        <div>
          <h2>Favorite Foods</h2>
        </div>
        <button id="create-food">Add food</button>
      </div>
      <div id="food-list"></div>
    </section>
  `;

  const renderList = (foods: Food[]) => {
    const listEl = container.querySelector('#food-list');
    if (!listEl) return;
    if (!foods.length) {
      listEl.innerHTML = '<p class="small-text">No foods saved yet.</p>';
      return;
    }
    const sorted = foods
      .slice()
      .sort((a, b) => (a.favorite === b.favorite ? a.name.localeCompare(b.name) : a.favorite ? -1 : 1));
    const favorites = sorted.filter((food) => food.favorite);
    const others = sorted.filter((food) => !food.favorite);

    const renderCards = (items: Food[]) =>
      items
        .map(
          (food) => {
            const basis = getFoodBasis(food);
            return `
            <div class="food-card">
              <button class="food-card__main" data-edit="${food.id}">
                <div class="food-card__title">
                  <span>${food.name}</span>
                </div>
                ${renderMacroSummary({
                  calories: food.caloriesPerServing,
                  carbs: food.carbsPerServing,
                  protein: food.proteinPerServing,
                  variant: 'inline',
                  label: basis.label,
                })}
              </button>
              <div class="food-card__actions">
                <button class="icon-button ghost favorite-toggle ${food.favorite ? 'is-active' : ''}" data-favorite="${
            food.id
          }" aria-label="${food.favorite ? 'Unfavorite' : 'Favorite'}">${food.favorite ? '★' : '☆'}</button>
                <button class="icon-button ghost" data-delete="${food.id}" aria-label="Delete food">🗑</button>
              </div>
            </div>`
          }
        )
        .join('');

    listEl.innerHTML = `
      ${favorites.length ? `<div class="list-section">${renderCards(favorites)}</div>` : ''}
      ${others.length ? `<div class="list-section"><h3>All Foods</h3>${renderCards(others)}</div>` : ''}
    `;
  };

  container.querySelector('#create-food')?.addEventListener('click', () => {
    setView('add-food');
  });

  const foods = state.foodCache.length ? state.foodCache : await getUserFoods();
  renderList(foods);

  container.querySelector('#food-list')?.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest<HTMLButtonElement>('button[data-edit],button[data-favorite],button[data-delete]');
    if (!button) return;
    const id = button.dataset.edit || button.dataset.favorite || button.dataset.delete;
    if (!id) return;
    const currentFood = state.foodCache.find((f) => f.id === id);
    if (!currentFood) return;
    if (button.dataset.edit) {
      setView('add-food', { foodId: id });
      return;
    }
    if (button.dataset.favorite) {
      if (!state.user) return;
      const foodRef = doc(db, 'users', state.user.uid, 'foods', currentFood.id);
      await updateDoc(foodRef, { favorite: !currentFood.favorite });
      state.foodCache = state.foodCache.map((f) => (f.id === currentFood.id ? { ...f, favorite: !f.favorite } : f));
      renderList(state.foodCache);
      return;
    }
    if (button.dataset.delete) {
      if (!state.user) return;
      const confirmed = await confirmDialog({
        title: 'Delete this food?',
        message: 'Historical entries will keep their stored nutrition snapshot.',
        confirmLabel: 'Delete food',
        tone: 'danger',
      });
      if (!confirmed) return;
      const foodRef = doc(db, 'users', state.user.uid, 'foods', currentFood.id);
      await deleteDoc(foodRef);
      state.foodCache = state.foodCache.filter((f) => f.id !== currentFood.id);
      renderList(state.foodCache);
    }
  });
};

const renderEntryForm = async (options: { date: string; entryId?: string }) => {
  const { date, entryId } = options;
  state.entryReturnContext = { date };
  applyViewState(entryId ? 'edit-entry' : 'add-entry');
  state.selectedDate = date;
  const container = buildShell();
  container.innerHTML = `
    <section class="card stack-card">
      <div class="compact-header back-row">
        <button id="back-dashboard" class="ghost back-link">← Back</button>
        <div>
          <p class="small-text">${entryId ? 'Edit entry' : 'Add entry'}</p>
          <h2>${formatDisplayDate(date)}</h2>
        </div>
      </div>
      <form id="entry-form" class="form-grid"></form>
    </section>
  `;
  container.querySelector('#back-dashboard')?.addEventListener('click', () => {
    setView('dashboard');
  });

  if (!state.entryFormFoodCacheLoaded) await getUserFoods();
  const foods = state.foodCache;

  const entryForm = container.querySelector<HTMLFormElement>('#entry-form');
  if (!entryForm) return;

  let selectedFood: Food | undefined;
  let servings = 1;
  let grams: number | null = null;
  let servingSizeGrams: number | null = null;
  let useGramsInput = false;
  let perServing = { calories: 0, carbs: 0, protein: 0 };
  let typedName = '';
  let macroBasisLabel = 'Per 100 g';
  let foodLocked = false;

  if (state.prefillFoodId) {
    const prefill = foods.find((f) => f.id === state.prefillFoodId);
    if (prefill) {
      selectedFood = prefill;
      typedName = prefill.name;
      perServing = {
        calories: prefill.caloriesPerServing,
        carbs: prefill.carbsPerServing,
        protein: prefill.proteinPerServing,
      };
      macroBasisLabel = getEntryMacroBasisLabel(prefill);
      servingSizeGrams = getServingSizeGramsValue(prefill);
      useGramsInput = !hasTrueServing(prefill) && Boolean(servingSizeGrams);
      grams = null;
    }
    state.prefillFoodId = undefined;
  }

  if (entryId && state.user) {
    const entryRef = doc(db, 'users', state.user.uid, 'entries', date, 'items', entryId);
    const entrySnap = await getDoc(entryRef);
    if (entrySnap.exists()) {
      const data = entrySnap.data() as Entry;
      typedName = data.foodName;
      servings = data.servings;
      perServing = {
        calories: data.caloriesPerServing,
        carbs: data.carbsPerServing,
        protein: data.proteinPerServing,
      };
      selectedFood = foods.find((f) => f.name === data.foodName) || undefined;
      macroBasisLabel = selectedFood ? getEntryMacroBasisLabel(selectedFood) : macroBasisLabel;
      servingSizeGrams = getServingSizeGramsValue(selectedFood);
      useGramsInput = !hasTrueServing(selectedFood) && Boolean(servingSizeGrams);
      if (useGramsInput && servingSizeGrams) {
        grams = roundTo2(servings * servingSizeGrams);
      }
    }
  }
  foodLocked = Boolean(selectedFood || (entryId && typedName.trim()));

  const updateTotals = () => {
    const calories = servings * perServing.calories;
    const carbs = servings * perServing.carbs;
    const protein = servings * perServing.protein;
    const totalsEl = entryForm.querySelector('#entry-totals');
    if (totalsEl) {
      totalsEl.innerHTML = renderMacroSummary({
        calories,
        carbs,
        protein,
        variant: 'compact',
        label: 'This entry',
      });
    }
  };

  const renderFoodSuggestions = (term: string) => {
    const suggestionEl = entryForm.querySelector<HTMLDivElement>('#food-suggestions');
    if (!suggestionEl) return;
    const filtered = sortFoodsForPicker(foods, term);
    if (filtered.length === 0 && term.trim()) {
      suggestionEl.innerHTML = `<div class="food-suggestions"><button type="button" id="create-food-inline" class="food-option-button">Create "${term}"</button></div>`;
      suggestionEl.querySelector('#create-food-inline')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setView('add-food', { prefillName: term, returnDate: date });
      });
      return;
    }
    suggestionEl.innerHTML = '<div class="food-suggestions"></div>';
    const list = suggestionEl.querySelector('.food-suggestions');
    filtered.forEach((food) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = selectedFood?.id === food.id;
      const basisLabel = getEntryMacroBasisLabel(food);
      btn.className = `food-option-button ${isSelected ? 'is-selected' : ''}`;
      btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      btn.innerHTML = `
        <div class="food-option">
          <div class="food-option__title">${food.favorite ? '<span class="favorite">★</span>' : ''}${food.name}</div>
          ${renderMacroSummary({
            calories: food.caloriesPerServing,
            carbs: food.carbsPerServing,
            protein: food.proteinPerServing,
            variant: 'inline',
            className: 'food-option__summary',
            label: basisLabel,
          })}
        </div>
      `;
      btn.addEventListener('click', () => {
        selectedFood = food;
        foodLocked = true;
        typedName = food.name;
        perServing = {
          calories: food.caloriesPerServing,
          carbs: food.carbsPerServing,
          protein: food.proteinPerServing,
        };
        servingSizeGrams = getServingSizeGramsValue(food);
        useGramsInput = !hasTrueServing(food) && Boolean(servingSizeGrams);
        grams = useGramsInput ? null : grams;
        updateMacroBasisLabels(getEntryMacroBasisLabel(food));
        const hiddenInput = entryForm.querySelector<HTMLInputElement>('#food');
        if (hiddenInput) hiddenInput.value = food.name;
        const selectedName = entryForm.querySelector<HTMLDivElement>('#selected-food-name');
        if (selectedName) selectedName.textContent = food.name;
        const caloriesInput = entryForm.querySelector<HTMLInputElement>('#calories');
        const carbsInput = entryForm.querySelector<HTMLInputElement>('#carbs');
        const proteinInput = entryForm.querySelector<HTMLInputElement>('#protein');
        if (caloriesInput) caloriesInput.value = formatNumberSmart(food.caloriesPerServing);
        if (carbsInput) carbsInput.value = formatNumberSmart(food.carbsPerServing);
        if (proteinInput) proteinInput.value = formatNumberSmart(food.proteinPerServing);
        renderFoodSuggestions(food.name);
        updateEntryInputMode(food);
        setFoodSelectionState(true);
        if (!macroEditorWasToggled) {
          setMacroEditorOpen(false);
        }
        const targetInput = entryForm.querySelector<HTMLInputElement>(useGramsInput ? '#grams' : '#servings');
        targetInput?.focus();
      });
      list?.appendChild(btn);
    });
  };

  entryForm.classList.add('form-grid--stack', 'entry-form');
  entryForm.innerHTML = `
    <div class="form-section">
      <div class="section-heading">
        <h3>Choose food</h3>
        <p class="small-text muted">Favorites show by default. Type to search your foods.</p>
      </div>
      <div id="food-picker" class="${foodLocked ? 'is-hidden' : ''}">
        <div class="field-group">
          <label for="food-search">Food</label>
          <input id="food-search" autocomplete="off" value="${typedName}" placeholder="Start typing a food" />
          <div id="food-suggestions"></div>
        </div>
      </div>
      <div id="selected-food-card" class="selected-food-card ${foodLocked ? '' : 'is-hidden'}">
        <div>
          <p class="small-text">Selected food</p>
          <div class="selected-food-card__name" id="selected-food-name">${selectedFood?.name ?? typedName}</div>
        </div>
        <div class="selected-food-card__actions">
          <button type="button" class="ghost small-button" id="edit-selected-food">Edit food</button>
          <button type="button" class="secondary small-button" id="change-selected-food">Change</button>
        </div>
      </div>
      <input type="hidden" id="food" name="food" value="${typedName}" />
    </div>
    <div class="form-section ${foodLocked ? '' : 'is-hidden'}" id="entry-amount-section">
      <div class="section-heading">
        <h3 id="entry-amount-heading">Servings</h3>
      </div>
      <div class="responsive-row">
        <div id="servings-field">
          <label for="servings">Servings</label>
          <input
            id="servings"
            name="servings"
            type="text"
            inputmode="decimal"
            placeholder="e.g., 1.25"
            value="${formatNumberSmart(servings)}"
            required
          />
          <p class="small-text muted" id="servings-help">Enter servings eaten (minimum 0.01).</p>
        </div>
        <div id="grams-field" class="is-hidden">
          <label for="grams" id="grams-label">Grams eaten</label>
          <input id="grams" name="grams" type="text" inputmode="decimal" placeholder="e.g., 162" />
        </div>
        <div class="totals-panel">
          <div id="entry-totals"></div>
        </div>
      </div>
      <button type="button" id="toggle-macros" class="ghost small-button">Edit macros</button>
    </div>
    <div id="macro-editor" class="form-section">
      <div class="section-heading">
        <h3 id="macro-basis-heading">Macros</h3>
        <p class="small-text muted" id="macro-basis-label"></p>
      </div>
      <div class="macro-grid">
        <div>
          <label for="calories">Calories</label>
          <input id="calories" name="calories" type="text" inputmode="decimal" value="${formatNumberSmart(
            perServing.calories
          )}" required />
        </div>
        <div>
          <label for="carbs">Carbs (g)</label>
          <input id="carbs" name="carbs" type="text" inputmode="decimal" value="${formatNumberSmart(
            perServing.carbs
          )}" required />
        </div>
        <div>
          <label for="protein">Protein (g)</label>
          <input id="protein" name="protein" type="text" inputmode="decimal" value="${formatNumberSmart(
            perServing.protein
          )}" required />
        </div>
      </div>
    </div>
    <div class="footer-actions">
      ${entryId ? '<button type="button" class="secondary" id="cancel-edit">Cancel</button>' : ''}
      <button type="submit">Save entry</button>
    </div>
  `;

  const updateMacroBasisLabels = (label: string) => {
    macroBasisLabel = label;
    const basisSuffix = label.replace(/^Per\\s+/i, 'per ');
    const headingEl = entryForm.querySelector<HTMLHeadingElement>('#macro-basis-heading');
    const basisEl = entryForm.querySelector<HTMLParagraphElement>('#macro-basis-label');
    const caloriesLabel = entryForm.querySelector<HTMLLabelElement>('label[for=\"calories\"]');
    const carbsLabel = entryForm.querySelector<HTMLLabelElement>('label[for=\"carbs\"]');
    const proteinLabel = entryForm.querySelector<HTMLLabelElement>('label[for=\"protein\"]');
    if (headingEl) headingEl.textContent = 'Macros';
    if (basisEl) basisEl.textContent = label;
    if (caloriesLabel) caloriesLabel.textContent = `Calories ${basisSuffix}`;
    if (carbsLabel) carbsLabel.textContent = `Carbs (g) ${basisSuffix}`;
    if (proteinLabel) proteinLabel.textContent = `Protein (g) ${basisSuffix}`;
  };

  const setFoodSelectionState = (locked: boolean) => {
    foodLocked = locked;
    const picker = entryForm.querySelector<HTMLDivElement>('#food-picker');
    const selectedCard = entryForm.querySelector<HTMLDivElement>('#selected-food-card');
    const selectedName = entryForm.querySelector<HTMLDivElement>('#selected-food-name');
    const amountSection = entryForm.querySelector<HTMLDivElement>('#entry-amount-section');
    const toggleMacros = entryForm.querySelector<HTMLButtonElement>('#toggle-macros');
    const hiddenInput = entryForm.querySelector<HTMLInputElement>('#food');
    const editButton = entryForm.querySelector<HTMLButtonElement>('#edit-selected-food');
    picker?.classList.toggle('is-hidden', locked);
    selectedCard?.classList.toggle('is-hidden', !locked);
    amountSection?.classList.toggle('is-hidden', !locked);
    toggleMacros?.classList.toggle('is-hidden', !locked);
    if (hiddenInput) hiddenInput.value = typedName;
    if (selectedName) selectedName.textContent = typedName;
    if (editButton) {
      editButton.classList.toggle('is-hidden', !selectedFood?.id);
    }
  };

  const updateEntryInputMode = (food?: Food) => {
    servingSizeGrams = getServingSizeGramsValue(food);
    useGramsInput = Boolean(food && !hasTrueServing(food) && servingSizeGrams);
    const headingEl = entryForm.querySelector<HTMLHeadingElement>('#entry-amount-heading');
    const servingsField = entryForm.querySelector<HTMLDivElement>('#servings-field');
    const gramsField = entryForm.querySelector<HTMLDivElement>('#grams-field');
    const servingsHelp = entryForm.querySelector<HTMLParagraphElement>('#servings-help');
    const gramsLabel = entryForm.querySelector<HTMLLabelElement>('#grams-label');
    if (headingEl) headingEl.textContent = useGramsInput ? 'Grams eaten' : 'Servings';
    if (servingsHelp) {
      servingsHelp.textContent = 'Enter servings eaten (minimum 0.01).';
    }
    if (gramsLabel) {
      gramsLabel.textContent = 'Grams eaten';
    }
    servingsField?.classList.toggle('is-hidden', useGramsInput);
    gramsField?.classList.toggle('is-hidden', !useGramsInput);
    if (useGramsInput) {
      const gramsInput = entryForm.querySelector<HTMLInputElement>('#grams');
      const gramsValue = grams ?? null;
      if (gramsInput) gramsInput.value = gramsValue ? formatNumberSmart(gramsValue) : '';
      if (servingSizeGrams) {
        servings = gramsValue ? gramsValue / servingSizeGrams : 0;
      } else {
        servings = 0;
      }
    } else {
      const servingsInput = entryForm.querySelector<HTMLInputElement>('#servings');
      if (servingsInput) servingsInput.value = formatNumberSmart(servings);
    }
    updateTotals();
  };

  updateMacroBasisLabels(macroBasisLabel);

  renderFoodSuggestions(typedName);
  updateEntryInputMode(selectedFood);
  setFoodSelectionState(foodLocked);

  const macroEditor = entryForm.querySelector<HTMLDivElement>('#macro-editor');
  const toggleMacrosBtn = entryForm.querySelector<HTMLButtonElement>('#toggle-macros');
  let macroEditorOpen = Boolean(entryId) || !selectedFood;
  let macroEditorWasToggled = false;

  const setMacroEditorOpen = (open: boolean, userToggle = false) => {
    macroEditorOpen = open;
    if (userToggle) macroEditorWasToggled = true;
    const shouldShow = foodLocked && open;
    macroEditor?.classList.toggle('is-hidden', !shouldShow);
    if (toggleMacrosBtn) {
      toggleMacrosBtn.textContent = open ? 'Hide macros' : 'Edit macros';
    }
  };

  setMacroEditorOpen(macroEditorOpen);

  toggleMacrosBtn?.addEventListener('click', () => {
    setMacroEditorOpen(!macroEditorOpen, true);
  });

  entryForm.querySelector<HTMLButtonElement>('#change-selected-food')?.addEventListener('click', () => {
    selectedFood = undefined;
    typedName = '';
    grams = null;
    updateMacroBasisLabels('Per 100 g');
    updateEntryInputMode(undefined);
    renderFoodSuggestions('');
    setFoodSelectionState(false);
    const input = entryForm.querySelector<HTMLInputElement>('#food-search');
    if (input) {
      input.value = '';
      input.focus();
    }
  });

  entryForm.querySelector<HTMLButtonElement>('#edit-selected-food')?.addEventListener('click', () => {
    if (!selectedFood?.id) return;
    setView('add-food', { foodId: selectedFood.id, returnDate: date });
  });

  const attachDecimalInput = (
    selector: string,
    min: number,
    onChange: (value: number) => void
  ) => {
    const input = entryForm.querySelector<HTMLInputElement>(selector);
    if (!input) return;
    input.addEventListener('input', () => {
      const parsed = parseDecimal2(input.value, min);
      onChange(parsed);
      updateTotals();
    });
    input.addEventListener('blur', () => {
      const parsed = parseDecimal2(input.value, min);
      input.value = formatNumberSmart(parsed);
      onChange(parsed);
      updateTotals();
    });
  };

  const attachNullableDecimalInput = (
    selector: string,
    min: number,
    onChange: (value: number | null) => void
  ) => {
    const input = entryForm.querySelector<HTMLInputElement>(selector);
    if (!input) return;
    const applyValue = (raw: string, finalize: boolean) => {
      const parsed = parseDecimalNullable(raw, min);
      onChange(parsed);
      if (finalize) {
        input.value = parsed == null ? '' : formatNumberSmart(parsed);
      }
      updateTotals();
    };
    input.addEventListener('input', () => applyValue(input.value, false));
    input.addEventListener('blur', () => applyValue(input.value, true));
  };

  attachDecimalInput('#servings', 0.01, (value) => {
    servings = value;
  });

  attachNullableDecimalInput('#grams', 0.01, (value) => {
    grams = value;
    if (useGramsInput && servingSizeGrams) {
      servings = value ? value / servingSizeGrams : 0;
    } else {
      servings = 0;
    }
  });

  attachDecimalInput('#calories', 0, (value) => {
    perServing.calories = value;
  });
  attachDecimalInput('#carbs', 0, (value) => {
    perServing.carbs = value;
  });
  attachDecimalInput('#protein', 0, (value) => {
    perServing.protein = value;
  });

  attachSelectAllOnFocus(entryForm.querySelector<HTMLInputElement>('#servings'));
  attachSelectAllOnFocus(entryForm.querySelector<HTMLInputElement>('#grams'));
  attachSelectAllOnFocus(entryForm.querySelector<HTMLInputElement>('#calories'));
  attachSelectAllOnFocus(entryForm.querySelector<HTMLInputElement>('#carbs'));
  attachSelectAllOnFocus(entryForm.querySelector<HTMLInputElement>('#protein'));

  if (state.prefillFoodId) {
    setTimeout(() => {
      const targetInput = entryForm.querySelector<HTMLInputElement>(useGramsInput ? '#grams' : '#servings');
      targetInput?.focus();
    }, 50);
  }

  entryForm.querySelector<HTMLInputElement>('#food-search')?.addEventListener('input', (e) => {
    typedName = (e.target as HTMLInputElement).value;
    selectedFood = undefined;
    grams = null;
    updateMacroBasisLabels('Per 100 g');
    updateEntryInputMode(undefined);
    setFoodSelectionState(false);
    renderFoodSuggestions(typedName);
    if (!macroEditorWasToggled) {
      setMacroEditorOpen(true);
    }
  });

  entryForm.querySelector('#cancel-edit')?.addEventListener('click', () => {
    setView('dashboard');
  });

  entryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.user) return;
    const formData = new FormData(entryForm);
    const foodName = String(formData.get('food') || '').trim();
    if (!foodName) {
      alert('Food name is required.');
      return;
    }
    if (useGramsInput) {
      if (!servingSizeGrams) {
        alert('Serving size grams are missing for this food.');
        return;
      }
      if (!grams || grams <= 0) {
        alert('Enter the grams eaten.');
        return;
      }
      servings = grams / servingSizeGrams;
    }
    const payload = {
      foodName,
      servings: roundTo2(servings),
      caloriesPerServing: roundTo2(perServing.calories),
      carbsPerServing: roundTo2(perServing.carbs),
      proteinPerServing: roundTo2(perServing.protein),
      createdAt: serverTimestamp(),
    };

    const normalizedFoodName = foodName.toLowerCase();
    const existingFood = state.foodCache.find(
      (food) => food.name.trim().toLowerCase() === normalizedFoodName
    );
    if (!existingFood) {
      await upsertFood({
        name: foodName,
        caloriesPerServing: perServing.calories,
        carbsPerServing: perServing.carbs,
        proteinPerServing: perServing.protein,
        favorite: false,
      });
    }
    if (entryId) {
      const entryRef = doc(db, 'users', state.user.uid, 'entries', date, 'items', entryId);
      await setDoc(entryRef, payload, { merge: true });
    } else {
      await addDoc(collection(db, 'users', state.user.uid, 'entries', date, 'items'), payload);
    }
    setView('dashboard');
  });
};

const renderShellAndRoute = () => {
  setView('dashboard');
};

onAuthStateChanged(auth, (user) => {
  state.user = user;
  state.lastWaterMl = undefined;
  if (!user) {
    state.inactivityTimer && window.clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
    renderLogin();
    return;
  }
  resetInactivityTimer();
  renderShellAndRoute();
});

appEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.id === 'nav-menu-toggle') {
    event.stopPropagation();
    setNavMenuOpen(!navMenuOpen);
  }
  if (target.id === 'nav-signout') {
    signOut(auth);
    setNavMenuOpen(false);
  }
  if (target.id === 'nav-dashboard') {
    setView('dashboard');
    setNavMenuOpen(false);
  }
  if (target.id === 'nav-foods') {
    setView('foods');
    setNavMenuOpen(false);
  }
  if (target.id === 'nav-add-entry' || target.id === 'nav-add-entry-fab') {
    setView('add-entry', { date: state.selectedDate });
    setNavMenuOpen(false);
  }
});
