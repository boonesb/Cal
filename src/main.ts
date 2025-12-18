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
type ActiveView = 'dashboard' | 'foods' | 'add-entry' | 'add-food';

const state: {
  user: User | null;
  selectedDate: string;
  view: View;
  activeView: ActiveView;
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
  activeView: 'dashboard',
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

const renderMacroChips = (options: {
  calories: number;
  carbs: number;
  protein: number;
  variant?: 'subtle' | 'solid';
  label?: string;
}) => {
  const { calories, carbs, protein, variant = 'solid', label } = options;
  const chipClass = variant === 'subtle' ? 'chip subtle' : 'chip';
  return `
    <div class="chip-row">
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

type UsdaFoodResult = {
  id: string;
  description: string;
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
      calories: findNutrient('1008'),
      carbs: findNutrient('1005'),
      protein: findNutrient('1003'),
    } as UsdaFoodResult;
  });
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

const showLoading = (message = 'Loading...') => {
  setAppContent(`<p>${message}</p>`);
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
};

const renderNav = () => {
  const navActive = (view: ActiveView) => {
    if (view === 'add-entry' && state.activeView === 'add-food' && state.returnToEntryAfterFoodSave) return 'active';
    if (view === 'foods' && state.activeView === 'add-food' && !state.returnToEntryAfterFoodSave) return 'active';
    return state.activeView === view ? 'active' : '';
  };
  const header = document.createElement('header');
  const title = document.createElement('h1');
  title.textContent = 'Calorie Tracker';
  const nav = document.createElement('div');
  nav.className = 'navbar';
  nav.innerHTML = `
    <button id="nav-dashboard" class="${navActive('dashboard')}">Dashboard</button>
    <button class="secondary ${navActive('foods')}" id="nav-foods">Foods</button>
    <button class="secondary ${navActive('add-entry')}" id="nav-add-entry">Add entry</button>
    <button class="secondary" id="nav-signout">Sign out</button>
  `;
  header.appendChild(title);
  header.appendChild(nav);
  return header;
};

const buildShell = () => {
  setAppContent('');
  appEl.appendChild(renderNav());
  const main = document.createElement('div');
  main.id = 'view-container';
  appEl.appendChild(main);
  return main;
};

const renderForView = (
  view: ActiveView,
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
    case 'add-food':
      renderAddFoodView({ prefillName: payload?.prefillName, returnDate: payload?.returnDate, foodId: payload?.foodId });
      break;
  }
};

const setView = (
  view: ActiveView,
  payload?: { date?: string; entryId?: string; prefillName?: string; foodId?: string; returnDate?: string }
) => {
  state.activeView = view;
  if (view !== 'add-food') {
    state.returnToEntryAfterFoodSave = false;
  }
  renderForView(view, payload);
};

const mobileQuery = window.matchMedia('(max-width: 640px)');
const handleMobileChange = () => {
  const prev = state.isMobile;
  state.isMobile = mobileQuery.matches;
  if (state.user && prev !== state.isMobile && state.activeView === 'foods') {
    renderForView('foods');
  }
};
mobileQuery.addEventListener('change', handleMobileChange);

const renderTotals = (entries: Entry[]) => {
  const totals = sumEntries(entries);
  return `
    <div class="totals">
      <div class="total-card">
        ${renderMacroChips({
          calories: totals.calories,
          carbs: totals.carbs,
          protein: totals.protein,
          label: 'Daily totals',
        })}
      </div>
    </div>
  `;
};

const renderDashboard = async (dateOverride?: string) => {
  state.view = 'dashboard';
  if (dateOverride) {
    state.selectedDate = dateOverride;
  }
  const container = buildShell();
  container.innerHTML = `
    <section class="card stack-card">
      <div class="dashboard-header">
        <div>
          <p class="small-text">Daily dashboard</p>
          <h2 id="selected-date">${state.selectedDate}</h2>
        </div>
        <div class="date-controls">
          <button id="prev-day" class="secondary">◀</button>
          <input type="date" id="date-picker" value="${state.selectedDate}" />
          <button id="next-day" class="secondary">▶</button>
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
        <li class="entry-row">
          <div class="entry-main">
            <strong>${entry.foodName}</strong>
            <div class="small-text">${formatNumberSmart(entry.servings)} serving(s)</div>
          </div>
          <div class="entry-meta">
            ${renderMacroChips({ calories, carbs, protein, variant: 'subtle' })}
            <div class="entry-actions">
              <button class="secondary" data-edit="${entry.id}">Edit</button>
              <button class="danger" data-delete="${entry.id}">Delete</button>
            </div>
          </div>
        </li>
      `;
    })
    .join('');

  entriesList.innerHTML = `<ul class="list">${rows}</ul>`;

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
      const confirmed = confirm('Delete this entry?');
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
  const form = document.createElement('form');
  form.className = 'form-grid';
  form.innerHTML = `
    <div class="field-group inline-action">
      <div class="field-main">
        <label for="food-name">Name</label>
        <input id="food-name" name="name" required value="${food?.name ?? prefillName ?? ''}" />
      </div>
      <div class="field-action">
        <button type="button" id="lookup-nutrition" class="secondary ghost">Lookup</button>
      </div>
      <p class="small-text">Editing foods will not change past entries. Lookups use USDA FoodData Central.</p>
      <div id="lookup-error" class="error-text"></div>
      <div id="lookup-results" class="food-suggestions"></div>
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
    <div class="footer-actions">
      <button type="submit">Save food</button>
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
  const caloriesInput = form.querySelector<HTMLInputElement>('#calories');
  const carbsInput = form.querySelector<HTMLInputElement>('#carbs');
  const proteinInput = form.querySelector<HTMLInputElement>('#protein');
  const lookupBtn = form.querySelector<HTMLButtonElement>('#lookup-nutrition');
  const lookupResults = form.querySelector<HTMLDivElement>('#lookup-results');
  const lookupError = form.querySelector<HTMLDivElement>('#lookup-error');

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
    results.forEach((result) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<strong>${result.description}</strong><div class="small-text">${formatNumberSmart(
        result.calories
      )} kcal • ${formatNumberSmart(result.carbs)} g carbs • ${formatNumberSmart(result.protein)} g protein</div>`;
      btn.addEventListener('click', () => {
        caloriesVal = parseDecimal2(String(result.calories || 0), 0);
        carbsVal = parseDecimal2(String(result.carbs || 0), 0);
        proteinVal = parseDecimal2(String(result.protein || 0), 0);
        if (caloriesInput) caloriesInput.value = formatNumberSmart(caloriesVal);
        if (carbsInput) carbsInput.value = formatNumberSmart(carbsVal);
        if (proteinInput) proteinInput.value = formatNumberSmart(proteinVal);
        lookupResults.innerHTML = '';
      });
      lookupResults.appendChild(btn);
    });
    lookupResults.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  lookupBtn?.addEventListener('click', async () => {
    if (!nameInput || !lookupError || !lookupResults || !lookupBtn) return;
    const term = nameInput.value.trim();
    lookupError.textContent = '';
    lookupResults.innerHTML = '';
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

  container.innerHTML = '';
  container.appendChild(form);
};

const renderAddFoodView = async (options?: { prefillName?: string; returnDate?: string; foodId?: string }) => {
  state.view = 'add-food';
  state.returnToEntryAfterFoodSave = Boolean(options?.returnDate);
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
        </div>
      </div>
      <div id="add-food-form"></div>
    </section>
  `;

  const goBack = () => {
    state.pendingEntryFoodName = undefined;
    state.returnToEntryAfterFoodSave = Boolean(options?.returnDate);
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
  state.view = 'foods';
  state.returnToEntryAfterFoodSave = false;
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

    if (state.isMobile) {
      const cards = sorted
        .map(
          (food) => `
            <div class="food-card">
              <div class="food-card__title">${food.favorite ? '<span class="favorite">★</span>' : ''}${food.name}</div>
              <div class="small-text muted">Per serving</div>
              ${renderMacroChips({
                calories: food.caloriesPerServing,
                carbs: food.carbsPerServing,
                protein: food.proteinPerServing,
                variant: 'subtle',
              })}
              <div class="food-card__actions">
                <button class="secondary" data-edit="${food.id}">Edit</button>
                <button class="secondary" data-favorite="${food.id}">${food.favorite ? 'Unfavorite' : 'Favorite'}</button>
                <button class="danger ghost" data-delete="${food.id}">Delete</button>
              </div>
            </div>`
        )
        .join('');
      listEl.innerHTML = cards;
      return;
    }

    const rows = sorted
      .map(
        (food) => `
        <div class="food-row">
          <div class="food-row__title">${food.favorite ? '<span class="favorite">★</span>' : ''}${food.name}</div>
          <div class="food-row__macros">
            ${renderMacroChips({
              calories: food.caloriesPerServing,
              carbs: food.carbsPerServing,
              protein: food.proteinPerServing,
              variant: 'subtle',
            })}
          </div>
          <div class="food-row__actions">
            <button class="secondary" data-edit="${food.id}">Edit</button>
            <button class="secondary" data-favorite="${food.id}">${food.favorite ? 'Unfavorite' : 'Favorite'}</button>
            <button class="danger ghost" data-delete="${food.id}">Delete</button>
          </div>
        </div>`
      )
      .join('');

    listEl.innerHTML = `
      <div class="food-row food-row--header">
        <div>Name</div>
        <div>Per serving</div>
        <div>Actions</div>
      </div>
      <div class="food-row-group">${rows}</div>
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
      const confirmed = confirm('Delete this food? Historical entries will keep their stored nutrition snapshot.');
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
  state.view = entryId ? 'edit-entry' : 'add-entry';
  state.selectedDate = date;
  const container = buildShell();
  container.innerHTML = `
    <section class="card stack-card">
      <div class="flex space-between back-row">
        <div>
          <p class="small-text">${entryId ? 'Edit entry' : 'Add entry'}</p>
          <h2>${date}</h2>
        </div>
        <button id="back-dashboard" class="ghost back-link">← Back</button>
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
      totalsEl.innerHTML = renderMacroChips({ calories, carbs, protein, label: 'Totals' });
    }
  };

  const renderFoodSuggestions = (term: string) => {
    const suggestionEl = entryForm.querySelector<HTMLDivElement>('#food-suggestions');
    if (!suggestionEl) return;
    const filtered = sortFoodsForPicker(foods, term);
    if (filtered.length === 0 && term.trim()) {
      suggestionEl.innerHTML = `<div class="food-suggestions"><button type="button" id="create-food-inline">Create "${term}"</button></div>`;
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
      btn.innerHTML = `
        <div class="food-option">
          <div class="food-option__title">${food.favorite ? '<span class="favorite">★</span>' : ''}${food.name}</div>
          ${renderMacroChips({
            calories: food.caloriesPerServing,
            carbs: food.carbsPerServing,
            protein: food.proteinPerServing,
            variant: 'subtle',
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
        const servingsInput = entryForm.querySelector<HTMLInputElement>('#servings');
        servingsInput?.focus();
      });
      list?.appendChild(btn);
    });
  };

  entryForm.innerHTML = `
    <div class="field-group">
      <label for="food">Food</label>
      <input id="food" name="food" autocomplete="off" value="${typedName}" placeholder="Start typing a food" />
      <p class="small-text">Favorites show by default; type to search your foods.</p>
      <div id="food-suggestions"></div>
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
        <p class="small-text">Enter amount eaten (minimum 0.01).</p>
      </div>
      <div class="totals-panel">
        <div id="entry-totals"></div>
      </div>
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
    <div class="footer-actions">
      ${entryId ? '<button type="button" class="secondary" id="cancel-edit">Cancel</button>' : ''}
      <button type="submit">Save entry</button>
    </div>
  `;

  renderFoodSuggestions(typedName);
  updateTotals();

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
  if (target.id === 'nav-signout') {
    signOut(auth);
  }
  if (target.id === 'nav-dashboard') {
    setView('dashboard');
  }
  if (target.id === 'nav-foods') {
    setView('foods');
  }
  if (target.id === 'nav-add-entry') {
    setView('add-entry', { date: state.selectedDate });
  }
});
