import './style.css';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
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
import { APP_VERSION, BUILD_TIME_ISO } from './generated/version';
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
};

type FoodDraft = {
  name: string;
  caloriesPerServing: number;
  carbsPerServing: number;
  proteinPerServing: number;
  servingLabel?: string;
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

const USDA_API_KEY = import.meta.env.VITE_USDA_API_KEY as string | undefined;

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

const roundTo2 = (num: number) => Math.round(num * 100) / 100;
const roundTo1 = (num: number) => Math.round(num * 10) / 10;

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
    return `<div class="macro-inline ${className ?? ''}">${caloriesText} • ${carbsText} • ${proteinText}</div>`;
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

type UsdaFoodResult = {
  id: string;
  description: string;
  dataType?: string;
  brandOwner?: string;
  calories: number;
  carbs: number;
  protein: number;
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
    body: JSON.stringify({ query: term, pageSize: 5 }),
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
      return Number(nutrient?.value ?? nutrient?.amount ?? 0);
    };
    return {
      id: String(food.fdcId ?? food.description),
      description: String(food.description ?? 'Food'),
      dataType: food.dataType ? String(food.dataType) : undefined,
      brandOwner: food.brandOwner ? String(food.brandOwner) : undefined,
      calories: findNutrient('1008'),
      carbs: findNutrient('1005'),
      protein: findNutrient('1003'),
    } as UsdaFoodResult;
  });
};

const normalizeBarcode = (value: string) => value.replace(/\D/g, '');

const isValidBarcode = (barcode: string) => barcode.length >= 8 && barcode.length <= 14;

const lookupByBarcode = async (barcode: string): Promise<FoodDraft | null> => {
  const response = await fetch(`https://world.openfoodfacts.net/api/v2/product/${encodeURIComponent(barcode)}`);
  if (!response.ok) {
    throw new Error('Unable to reach Open Food Facts right now.');
  }
  const data = await response.json();
  if (!data || data.status !== 1 || !data.product) {
    return null;
  }
  const product = data.product;
  const nutriments = product.nutriments || {};
  const asNumber = (value: any) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const kjToKcal = (value: number | null) => (value == null ? null : value / 4.184);

  const energyServing = asNumber(nutriments['energy-kcal_serving']) ?? kjToKcal(asNumber(nutriments['energy-kj_serving']));
  const energy100g = asNumber(nutriments['energy-kcal_100g']) ?? kjToKcal(asNumber(nutriments['energy-kj_100g']));
  const calories = energyServing ?? energy100g;

  const proteinServing = asNumber(nutriments['proteins_serving']);
  const protein100g = asNumber(nutriments['proteins_100g']);
  const carbsServing = asNumber(nutriments['carbohydrates_serving']);
  const carbs100g = asNumber(nutriments['carbohydrates_100g']);

  if (calories == null && proteinServing == null && protein100g == null && carbsServing == null && carbs100g == null) {
    return null;
  }

  const usingServing = energyServing != null || proteinServing != null || carbsServing != null;
  const servingLabel: string | undefined = usingServing
    ? (typeof product.serving_size === 'string' && product.serving_size.trim()) || undefined
    : '100 g';

  const safeCalories = calories != null ? Math.max(0, Math.round(calories)) : 0;
  const protein = proteinServing ?? protein100g ?? 0;
  const carbs = carbsServing ?? carbs100g ?? 0;
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
    servingLabel,
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

const setAppContent = (html: string) => {
  appEl.innerHTML = html;
};

const renderFooter = () => {
  const footer = document.createElement('footer');
  footer.className = 'app-footer';
  footer.textContent = `v ${APP_VERSION} · ${BUILD_TIME_ISO}`;
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

const createBarcodeScanModal = (options: {
  onLookup: (barcode: string) => Promise<FoodDraft | null>;
  onDetected: (draft: FoodDraft, barcode: string) => Promise<void>;
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
      const draft = await options.onLookup(normalized);
      if (!draft) {
        onNotFound();
        return;
      }
      await options.onDetected(draft, normalized);
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
        <button id="nav-add-entry" class="primary-cta ${navActive('entry')}">Add entry</button>
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
  `;
  return header;
};

const buildShell = () => {
  setAppContent('');
  appEl.appendChild(renderNav());
  setNavMenuOpen(false);
  const main = document.createElement('div');
  main.id = 'view-container';
  appEl.appendChild(main);
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

const renderTotals = (entries: Entry[]) => {
  const totals = sumEntries(entries);
  return `
    <div class="totals">
      <div class="total-card total-card--hero">
        ${renderMacroSummary({
          calories: totals.calories,
          carbs: totals.carbs,
          protein: totals.protein,
          label: 'Daily totals',
          variant: 'hero',
        })}
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
    <section class="card stack-card">
      <div class="dashboard-header">
        <div>
          <p class="small-text">Daily dashboard</p>
          <h2 id="selected-date">${formatDisplayDate(state.selectedDate)}</h2>
        </div>
        <div class="date-row">
          <button id="date-display" class="date-display" type="button" aria-label="Select date">
            <span class="date-value">${formatDisplayDate(state.selectedDate)}</span>
            <span class="date-caret">▼</span>
          </button>
          <div class="date-controls">
            <button id="prev-day" class="ghost icon-button" aria-label="Previous day">‹</button>
            <button id="next-day" class="ghost icon-button" aria-label="Next day">›</button>
          </div>
          <input type="date" id="date-picker" class="visually-hidden" value="${state.selectedDate}" />
        </div>
      </div>
      <div id="totals"></div>
    </section>
    <section class="card stack-card">
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

  const entries = await fetchEntriesForDate(state.selectedDate);
  totalsEl.innerHTML = renderTotals(entries);

  if (!entries.length) {
    entriesList.innerHTML = '<p class="small-text">No entries yet for this date.</p>';
    return;
  }

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
};

const upsertFood = async (food: Partial<Food> & { name: string }) => {
  if (!state.user) throw new Error('No user');
  const payload = {
    caloriesPerServing: roundTo2(Number(food.caloriesPerServing ?? 0)),
    carbsPerServing: roundTo2(Number(food.carbsPerServing ?? 0)),
    proteinPerServing: roundTo2(Number(food.proteinPerServing ?? 0)),
    favorite: Boolean(food.favorite),
    name: food.name.trim(),
    createdAt: serverTimestamp(),
  };

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
  let previousDraft: FoodDraft | null = null;
  const scanSupported = Boolean(navigator.mediaDevices?.getUserMedia);
  const form = document.createElement('form');
  form.className = 'form-grid form-grid--stack';
  form.innerHTML = `
    <div class="form-section find-section">
      <div class="section-heading">
        <p class="section-eyebrow">Find your food</p>
        <h3>Find your food</h3>
        <p class="small-text muted">We’ll fill calories and macros for you.</p>
      </div>
      <div class="find-actions">
        <div class="find-card" id="lookup-card">
          <div class="field-group">
            <label for="lookup-term">Search USDA by name</label>
            <p class="small-text muted">Search USDA FoodData Central and autofill fields.</p>
            <div class="lookup-input-row">
              <input id="lookup-term" name="lookupTerm" placeholder="Search foods by name" value="${prefillName ?? ''}" />
              <button type="button" id="lookup-nutrition" class="secondary">Lookup</button>
            </div>
          </div>
          <div id="lookup-error" class="error-text"></div>
          <div id="lookup-results" class="lookup-results lookup-results--collapsed" aria-live="polite"></div>
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
      <div class="autofill-meta">
        <div id="serving-context" class="small-text muted"></div>
        <div id="autofill-status" class="autofill-status is-hidden" role="status">
          <span id="autofill-status-text"></span>
          <button type="button" class="ghost small-button" id="autofill-reset">Reset to previous values</button>
        </div>
      </div>
    </div>
    <div class="form-section manual-section">
      <div class="section-heading">
        <p class="section-eyebrow">Or enter it manually</p>
        <h3>Or enter it manually</h3>
        <p class="small-text muted">Use this when you can’t find an exact match.</p>
      </div>
      <div class="manual-card">
        <div class="field-group">
          <label for="food-name">Name</label>
          <input id="food-name" name="name" required value="${food?.name ?? prefillName ?? ''}" />
        </div>
        <div class="macro-grid">
          <div>
            <label for="calories">Calories / serving</label>
            <input id="calories" name="caloriesPerServing" type="text" inputmode="decimal" required value="${formatNumberSmart(
              caloriesVal
            )}" />
          </div>
          <div>
            <label for="carbs">Carbs (g) / serving</label>
            <input id="carbs" name="carbsPerServing" type="text" inputmode="decimal" required value="${formatNumberSmart(
              carbsVal
            )}" />
          </div>
          <div>
            <label for="protein">Protein (g) / serving</label>
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
    const payload = {
      id: food?.id,
      name: String(formData.get('name') || '').trim(),
      caloriesPerServing: caloriesVal,
      carbsPerServing: carbsVal,
      proteinPerServing: proteinVal,
      favorite: formData.get('favorite') === 'true',
    } as Food;
    const id = await upsertFood(payload);
    const savedFood = { ...payload, id } as Food;
    onSave(savedFood);
  });

  const nameInput = form.querySelector<HTMLInputElement>('#food-name');
  const lookupInput = form.querySelector<HTMLInputElement>('#lookup-term');
  const caloriesInput = form.querySelector<HTMLInputElement>('#calories');
  const carbsInput = form.querySelector<HTMLInputElement>('#carbs');
  const proteinInput = form.querySelector<HTMLInputElement>('#protein');
  const lookupBtn = form.querySelector<HTMLButtonElement>('#lookup-nutrition');
  const scanBtn = form.querySelector<HTMLButtonElement>('#scan-barcode');
  const lookupResults = form.querySelector<HTMLDivElement>('#lookup-results');
  const lookupError = form.querySelector<HTMLDivElement>('#lookup-error');
  const barcodeStatus = form.querySelector<HTMLDivElement>('#barcode-status');
  const servingContextEl = form.querySelector<HTMLDivElement>('#serving-context');
  const autofillStatus = form.querySelector<HTMLDivElement>('#autofill-status');
  const autofillStatusText = form.querySelector<HTMLSpanElement>('#autofill-status-text');
  const autofillReset = form.querySelector<HTMLButtonElement>('#autofill-reset');

  const updateServingContext = (label?: string) => {
    servingLabel = label;
    if (servingContextEl) {
      servingContextEl.textContent = label ? `Serving: ${label}` : '';
    }
  };

  const setLookupCollapsed = (collapsed: boolean) => {
    lookupResults?.classList.toggle('lookup-results--collapsed', collapsed);
  };

  const clearLookupResults = () => {
    if (lookupResults) lookupResults.innerHTML = '';
    setLookupCollapsed(true);
  };

  setLookupCollapsed(true);

  const setBarcodeStatus = (message: string) => {
    if (barcodeStatus) barcodeStatus.textContent = message;
  };

  const setAutofillStatus = (message: string, allowReset: boolean) => {
    if (!autofillStatus || !autofillStatusText || !autofillReset) return;
    autofillStatusText.textContent = message;
    autofillStatus.classList.remove('is-hidden');
    autofillReset.classList.toggle('is-hidden', !allowReset);
  };

  const captureCurrentDraft = (): FoodDraft => ({
    name: nameInput?.value ?? '',
    caloriesPerServing: caloriesVal,
    carbsPerServing: carbsVal,
    proteinPerServing: proteinVal,
    servingLabel,
  });

  const restoreDraft = (draft: FoodDraft) => {
    caloriesVal = draft.caloriesPerServing;
    carbsVal = draft.carbsPerServing;
    proteinVal = draft.proteinPerServing;
    if (nameInput) nameInput.value = draft.name;
    if (caloriesInput) caloriesInput.value = formatNumberSmart(caloriesVal);
    if (carbsInput) carbsInput.value = formatNumberSmart(carbsVal);
    if (proteinInput) proteinInput.value = formatNumberSmart(proteinVal);
    updateServingContext(draft.servingLabel);
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

  const applyDraftFromLookup = (draft: FoodDraft) => {
    previousDraft = captureCurrentDraft();
    restoreDraft(draft);
    setAutofillStatus('Filled from USDA lookup.', Boolean(previousDraft));
    clearLookupResults();
    nameInput?.focus();
  };

  const applyDraftFromBarcode = (draft: FoodDraft, barcode?: string) => {
    previousDraft = captureCurrentDraft();
    caloriesVal = draft.caloriesPerServing;
    carbsVal = draft.carbsPerServing;
    proteinVal = draft.proteinPerServing;
    if (nameInput) nameInput.value = draft.name;
    if (caloriesInput) caloriesInput.value = formatNumberSmart(caloriesVal);
    if (carbsInput) carbsInput.value = formatNumberSmart(carbsVal);
    if (proteinInput) proteinInput.value = formatNumberSmart(proteinVal);
    updateServingContext(draft.servingLabel);
    caloriesInput?.focus();
    setBarcodeStatus(
      barcode
        ? `Found ${barcode}${draft.servingLabel ? ` • ${draft.servingLabel}` : ''}. Review and save.`
        : ''
    );
    setAutofillStatus('Filled from barcode scan.', Boolean(previousDraft));
    clearLookupResults();
  };

  const openUsdaModal = (result: UsdaFoodResult) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal__header">
          <h3>Use this USDA result</h3>
          <button type="button" class="ghost icon-button" id="close-usda-modal">✕</button>
        </div>
        <div class="modal__body">
          <div class="usda-modal__summary">
            <div class="usda-result__title">${result.description}</div>
            <div class="usda-result__meta">
              ${result.dataType ? `<span class="badge badge--type">${result.dataType}</span>` : ''}
              ${result.brandOwner ? `<span class="small-text muted">${result.brandOwner}</span>` : ''}
            </div>
          </div>
          <label for="usda-serving-grams">My serving (g)</label>
          <input id="usda-serving-grams" type="text" inputmode="decimal" value="100" />
          <p class="small-text muted">We will estimate per-serving nutrition from this grams amount. USDA reference per 100g: ${formatNumberSmart(
            result.calories
          )} kcal • ${formatNumberSmart(result.carbs)} g carbs • ${formatNumberSmart(result.protein)} g protein.</p>
        </div>
        <div class="footer-actions modal__actions">
          <button type="button" class="secondary" id="cancel-usda">Cancel</button>
          <button type="button" id="apply-usda">Apply to form</button>
        </div>
      </div>
    `;
    const removeModal = () => overlay.remove();
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) removeModal();
    });
    overlay.querySelector('#cancel-usda')?.addEventListener('click', removeModal);
    overlay.querySelector('#close-usda-modal')?.addEventListener('click', removeModal);
    const applyBtn = overlay.querySelector<HTMLButtonElement>('#apply-usda');
    const gramsInput = overlay.querySelector<HTMLInputElement>('#usda-serving-grams');
    applyBtn?.addEventListener('click', async () => {
      const confirmed = await confirmOverwriteIfNeeded('USDA lookup');
      if (!confirmed) return;
      const gramsVal = parseDecimal2(gramsInput?.value ?? '0', 1);
      const factor = gramsVal / 100;
      const draft: FoodDraft = {
        name: result.description,
        caloriesPerServing: roundTo2(result.calories * factor),
        carbsPerServing: roundTo2(result.carbs * factor),
        proteinPerServing: roundTo2(result.protein * factor),
        servingLabel: `${formatNumberSmart(gramsVal)} g`,
      };
      applyDraftFromLookup(draft);
      if (lookupInput) lookupInput.value = result.description;
      setBarcodeStatus('');
      removeModal();
    });
    document.body.appendChild(overlay);
    gramsInput?.focus();
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

  const renderLookupResults = (results: UsdaFoodResult[]) => {
    if (!lookupResults) return;
    lookupResults.innerHTML = '';
    setLookupCollapsed(false);
    results.forEach((result) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'usda-result';
      btn.innerHTML = `
        <div class="usda-result__header">
          <div class="usda-result__title">${result.description}</div>
          ${result.dataType ? `<span class="badge badge--type">${result.dataType}</span>` : ''}
        </div>
        ${result.brandOwner ? `<div class="small-text muted">${result.brandOwner}</div>` : ''}
        <div class="small-text">Per 100g: ${formatNumberSmart(result.calories)} kcal • ${formatNumberSmart(
        result.carbs
      )} g carbs • ${formatNumberSmart(result.protein)} g protein</div>`;
      btn.addEventListener('click', () => openUsdaModal(result));
      lookupResults.appendChild(btn);
    });
    lookupResults.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  lookupBtn?.addEventListener('click', async () => {
    if (!lookupInput || !lookupError || !lookupResults || !lookupBtn) return;
    const term = lookupInput.value.trim();
    lookupError.textContent = '';
    lookupResults.innerHTML = '';
    setLookupCollapsed(false);
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
      if (!results.length) {
        lookupError.textContent = 'No matches found.';
        return;
      }
      renderLookupResults(results);
    } catch (err: any) {
      lookupError.textContent = err?.message ?? 'Lookup failed. Try again later.';
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = originalText;
    }
  });

  autofillReset?.addEventListener('click', () => {
    if (!previousDraft) return;
    restoreDraft(previousDraft);
    setAutofillStatus('Restored previous values.', false);
    previousDraft = null;
    setBarcodeStatus('');
  });

  scanBtn?.addEventListener('click', () => {
    createBarcodeScanModal({
      onLookup: async (barcode) => lookupByBarcode(barcode),
      onDetected: async (draft, barcode) => {
        const confirmed = await confirmOverwriteIfNeeded('barcode scan');
        if (!confirmed) return;
        applyDraftFromBarcode(draft, barcode);
      },
    });
  });

  container.innerHTML = '';
  container.appendChild(form);
};

const renderAddFoodView = async (options?: { prefillName?: string; returnDate?: string; foodId?: string }) => {
  applyViewState('add-food', { returnDate: options?.returnDate });
  state.pendingEntryFoodName = options?.prefillName;
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
          <p class="small-text">${options?.prefillName && !editingFood ? 'Create food' : heading}</p>
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

  container.querySelector('#back-from-food')?.addEventListener('click', goBack);

  const host = container.querySelector<HTMLDivElement>('#add-food-form');
  if (!host) return;

  renderFoodForm({
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
};

const renderFoods = async () => {
  applyViewState('foods');
  const container = buildShell();
  container.innerHTML = `
    <section class="card stack-card">
      <div class="compact-header">
        <div>
          <p class="small-text">Saved foods</p>
          <h2>Foods</h2>
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
          (food) => `
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
                })}
              </button>
              <div class="food-card__actions">
                <button class="icon-button ghost favorite-toggle ${food.favorite ? 'is-active' : ''}" data-favorite="${
            food.id
          }" aria-label="${food.favorite ? 'Unfavorite' : 'Favorite'}">${food.favorite ? '★' : '☆'}</button>
                <button class="icon-button ghost" data-delete="${food.id}" aria-label="Delete food">🗑</button>
              </div>
            </div>`
        )
        .join('');

    listEl.innerHTML = `
      ${favorites.length ? `<div class="list-section"><h3>Favorites</h3>${renderCards(favorites)}</div>` : ''}
      ${others.length ? `<div class="list-section"><h3>All foods</h3>${renderCards(others)}</div>` : ''}
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
  let perServing = { calories: 0, carbs: 0, protein: 0 };
  let typedName = '';

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
    }
  }

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
    const selectedSummary = entryForm.querySelector<HTMLDivElement>('#selected-food-summary');
    if (!suggestionEl) return;
    const filtered = sortFoodsForPicker(foods, term);
    if (filtered.length === 0 && term.trim()) {
      suggestionEl.innerHTML = `<div class="food-suggestions"><button type="button" id="create-food-inline" class="food-option-button">Create "${term}"</button></div>`;
      suggestionEl.querySelector('#create-food-inline')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setView('add-food', { prefillName: term, returnDate: date });
      });
      if (selectedSummary) selectedSummary.textContent = '';
      return;
    }
    suggestionEl.innerHTML = '<div class="food-suggestions"></div>';
    const list = suggestionEl.querySelector('.food-suggestions');
    filtered.forEach((food) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = selectedFood?.id === food.id;
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
          })}
        </div>
      `;
      btn.addEventListener('click', () => {
        selectedFood = food;
        perServing = {
          calories: food.caloriesPerServing,
          carbs: food.carbsPerServing,
          protein: food.proteinPerServing,
        };
        const input = entryForm.querySelector<HTMLInputElement>('#food');
        if (input) input.value = food.name;
        const caloriesInput = entryForm.querySelector<HTMLInputElement>('#calories');
        const carbsInput = entryForm.querySelector<HTMLInputElement>('#carbs');
        const proteinInput = entryForm.querySelector<HTMLInputElement>('#protein');
        if (caloriesInput) caloriesInput.value = formatNumberSmart(food.caloriesPerServing);
        if (carbsInput) carbsInput.value = formatNumberSmart(food.carbsPerServing);
        if (proteinInput) proteinInput.value = formatNumberSmart(food.proteinPerServing);
        renderFoodSuggestions(food.name);
        updateTotals();
        if (!macroEditorWasToggled) {
          setMacroEditorOpen(false);
        }
        const servingsInput = entryForm.querySelector<HTMLInputElement>('#servings');
        servingsInput?.focus();
      });
      list?.appendChild(btn);
    });
    if (selectedSummary && selectedFood) {
      selectedSummary.textContent = `Using saved macros for ${selectedFood.name}.`;
    } else if (selectedSummary) {
      selectedSummary.textContent = '';
    }
  };

  entryForm.classList.add('form-grid--stack', 'entry-form');
  entryForm.innerHTML = `
    <div class="form-section">
      <div class="section-heading">
        <p class="section-eyebrow">Step 1</p>
        <h3>Choose food</h3>
        <p class="small-text muted">Favorites show by default. Type to search your foods.</p>
      </div>
      <div class="field-group">
        <label for="food">Food</label>
        <input id="food" name="food" autocomplete="off" value="${typedName}" placeholder="Start typing a food" />
        <div id="selected-food-summary" class="small-text muted"></div>
        <div id="food-suggestions"></div>
      </div>
    </div>
    <div class="form-section">
      <div class="section-heading">
        <p class="section-eyebrow">Step 2</p>
        <h3>Servings</h3>
      </div>
      <div class="responsive-row">
        <div>
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
          <p class="small-text muted">Enter amount eaten (minimum 0.01).</p>
        </div>
        <div class="totals-panel">
          <div id="entry-totals"></div>
        </div>
      </div>
      <button type="button" id="toggle-macros" class="ghost small-button">Edit macros</button>
    </div>
    <div id="macro-editor" class="form-section">
      <div class="section-heading">
        <p class="section-eyebrow">Step 3</p>
        <h3>Per-serving macros</h3>
      </div>
      <div class="macro-grid">
        <div>
          <label for="calories">Calories per serving</label>
          <input id="calories" name="calories" type="text" inputmode="decimal" value="${formatNumberSmart(
            perServing.calories
          )}" required />
        </div>
        <div>
          <label for="carbs">Carbs (g) per serving</label>
          <input id="carbs" name="carbs" type="text" inputmode="decimal" value="${formatNumberSmart(
            perServing.carbs
          )}" required />
        </div>
        <div>
          <label for="protein">Protein (g) per serving</label>
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

  renderFoodSuggestions(typedName);
  updateTotals();

  const macroEditor = entryForm.querySelector<HTMLDivElement>('#macro-editor');
  const toggleMacrosBtn = entryForm.querySelector<HTMLButtonElement>('#toggle-macros');
  let macroEditorOpen = Boolean(entryId) || !selectedFood;
  let macroEditorWasToggled = false;

  const setMacroEditorOpen = (open: boolean, userToggle = false) => {
    macroEditorOpen = open;
    if (userToggle) macroEditorWasToggled = true;
    macroEditor?.classList.toggle('is-hidden', !open);
    if (toggleMacrosBtn) {
      toggleMacrosBtn.textContent = open ? 'Hide macros' : 'Edit macros';
    }
  };

  setMacroEditorOpen(macroEditorOpen);

  toggleMacrosBtn?.addEventListener('click', () => {
    setMacroEditorOpen(!macroEditorOpen, true);
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

  attachDecimalInput('#servings', 0.01, (value) => {
    servings = value;
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

  if (state.prefillFoodId) {
    setTimeout(() => {
      entryForm.querySelector<HTMLInputElement>('#servings')?.focus();
    }, 50);
  }

  entryForm.querySelector<HTMLInputElement>('#food')?.addEventListener('input', (e) => {
    typedName = (e.target as HTMLInputElement).value;
    selectedFood = undefined;
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
  if (target.id === 'nav-add-entry') {
    setView('add-entry', { date: state.selectedDate });
    setNavMenuOpen(false);
  }
});
