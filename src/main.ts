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

const todayStr = () => new Date().toISOString().slice(0, 10);

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

const state: {
  user: User | null;
  selectedDate: string;
  foodCache: Food[];
  entryFormFoodCacheLoaded: boolean;
  inactivityTimer: number | null;
  entryReturnContext: { date: string; entryId?: string } | null;
  prefillFoodId?: string;
} = {
  user: null,
  selectedDate: todayStr(),
  foodCache: [],
  entryFormFoodCacheLoaded: false,
  inactivityTimer: null,
  entryReturnContext: null,
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

const formatNumber = (num: number) => Math.round(num * 100) / 100;

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
  const response = await fetch('https://api.nal.usda.gov/fdc/v1/foods/search', {
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
    const findNutrient = (nutrientNumber: string) => {
      const nutrient = nutrients.find((n: any) => String(n.nutrientNumber) === nutrientNumber);
      return Number(nutrient?.value ?? 0);
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
  const matches = foods.filter((food) =>
    keyword === '' ? true : food.name.toLowerCase().includes(keyword)
  );
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

  console.log("state.user.uid:", state.user.uid);
  console.log("auth.currentUser.uid:", auth.currentUser?.uid);
  
  const entryCol = collection(db, 'users', state.user.uid, 'entries', date, 'items');
  console.log("state.user.uid:", state.user?.uid);
  console.log("auth.currentUser.uid:", auth.currentUser?.uid);
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
  const header = document.createElement('header');
  const title = document.createElement('h1');
  title.textContent = 'Calorie Tracker';
  const nav = document.createElement('div');
  nav.className = 'navbar';
  nav.innerHTML = `
    <button id="nav-dashboard">Dashboard</button>
    <button class="secondary" id="nav-foods">Foods</button>
    <button class="secondary" id="nav-add-entry">Add entry</button>
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

const renderTotals = (entries: Entry[]) => {
  const totals = sumEntries(entries);
  return `
    <div class="totals">
      <div class="total-card"><div class="small-text">Calories</div><div class="chip">${formatNumber(totals.calories)}</div></div>
      <div class="total-card"><div class="small-text">Carbs (g)</div><div class="chip">${formatNumber(totals.carbs)}</div></div>
      <div class="total-card"><div class="small-text">Protein (g)</div><div class="chip">${formatNumber(totals.protein)}</div></div>
    </div>
  `;
};

const renderDashboard = async () => {
  const container = buildShell();
  container.innerHTML = `
    <section class="card">
      <div class="flex space-between">
        <div>
          <p class="small-text">Daily dashboard</p>
          <h2 id="selected-date">${state.selectedDate}</h2>
        </div>
        <div class="flex">
          <button id="prev-day" class="secondary">◀</button>
          <input type="date" id="date-picker" value="${state.selectedDate}" />
          <button id="next-day" class="secondary">▶</button>
        </div>
      </div>
      <div id="totals"></div>
    </section>
    <section class="card">
      <div class="flex space-between">
        <h3>Entries</h3>
        <button id="add-entry">Add entry</button>
      </div>
      <div id="entries-list"></div>
    </section>
  `;

  const updateDate = (newDate: string) => {
    state.selectedDate = newDate;
    renderDashboard();
  };

  container.querySelector('#prev-day')?.addEventListener('click', () => {
    const current = new Date(state.selectedDate);
    current.setDate(current.getDate() - 1);
    updateDate(current.toISOString().slice(0, 10));
  });

  container.querySelector('#next-day')?.addEventListener('click', () => {
    const current = new Date(state.selectedDate);
    current.setDate(current.getDate() + 1);
    updateDate(current.toISOString().slice(0, 10));
  });

  container.querySelector<HTMLInputElement>('#date-picker')?.addEventListener('change', (e) => {
    const value = (e.target as HTMLInputElement).value;
    updateDate(value || todayStr());
  });

  container.querySelector('#add-entry')?.addEventListener('click', () => {
    state.entryReturnContext = null;
    renderEntryForm({ date: state.selectedDate });
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
        <li>
          <div>
            <strong>${entry.foodName}</strong>
            <div class="small-text">${entry.servings} serving(s)</div>
          </div>
          <div class="entry-actions">
            <div class="chip">${formatNumber(calories)} kcal</div>
            <div class="chip">${formatNumber(carbs)} g carbs</div>
            <div class="chip">${formatNumber(protein)} g protein</div>
            <button class="secondary" data-edit="${entry.id}">Edit</button>
            <button class="danger" data-delete="${entry.id}">Delete</button>
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
      renderEntryForm({ date: state.selectedDate, entryId });
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
      renderDashboard();
    })
  );
};

const upsertFood = async (food: Partial<Food> & { name: string }) => {
  if (!state.user) throw new Error('No user');
  const payload = {
    caloriesPerServing: Number(food.caloriesPerServing ?? 0),
    carbsPerServing: Number(food.carbsPerServing ?? 0),
    proteinPerServing: Number(food.proteinPerServing ?? 0),
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
  const form = document.createElement('form');
  form.className = 'form-grid';
  form.innerHTML = `
    <div>
      <label for="food-name">Name</label>
      <input id="food-name" name="name" required value="${food?.name ?? prefillName ?? ''}" />
      <p class="small-text">Editing foods will not change past entries.</p>
    </div>
    <div>
      <button type="button" id="lookup-nutrition">Lookup nutrition</button>
      <p class="small-text">Uses USDA FoodData Central; values may be per 100g—adjust per serving.</p>
      <div id="lookup-error" class="error-text"></div>
      <div id="lookup-results" class="food-suggestions"></div>
    </div>
    <div>
      <label for="calories">Calories / serving</label>
      <input id="calories" name="caloriesPerServing" type="number" min="0" required value="${
        food?.caloriesPerServing ?? ''
      }" />
    </div>
    <div>
      <label for="carbs">Carbs (g) / serving</label>
      <input id="carbs" name="carbsPerServing" type="number" min="0" required value="${
        food?.carbsPerServing ?? ''
      }" />
    </div>
    <div>
      <label for="protein">Protein (g) / serving</label>
      <input id="protein" name="proteinPerServing" type="number" min="0" required value="${
        food?.proteinPerServing ?? ''
      }" />
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
      caloriesPerServing: Number(formData.get('caloriesPerServing') || 0),
      carbsPerServing: Number(formData.get('carbsPerServing') || 0),
      proteinPerServing: Number(formData.get('proteinPerServing') || 0),
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

  const renderLookupResults = (results: UsdaFoodResult[]) => {
    if (!lookupResults) return;
    lookupResults.innerHTML = '';
    results.forEach((result) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `<strong>${result.description}</strong><div class="small-text">${formatNumber(
        result.calories
      )} kcal • ${formatNumber(result.carbs)} g carbs • ${formatNumber(result.protein)} g protein</div>`;
      btn.addEventListener('click', () => {
        if (caloriesInput) caloriesInput.value = String(result.calories || 0);
        if (carbsInput) carbsInput.value = String(result.carbs || 0);
        if (proteinInput) proteinInput.value = String(result.protein || 0);
        lookupResults.innerHTML = '';
      });
      lookupResults.appendChild(btn);
    });
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

const renderFoods = async () => {
  const container = buildShell();
  container.innerHTML = `
    <section class="card">
      <div class="flex space-between">
        <div>
          <p class="small-text">Saved foods</p>
          <h2>Foods</h2>
        </div>
        <button id="create-food">Add food</button>
      </div>
      <div id="food-form"></div>
      <div id="food-list" class="card"></div>
    </section>
  `;

  const foodFormContainer = container.querySelector('#food-form');
  if (!foodFormContainer) return;

  const renderList = (foods: Food[]) => {
    const listEl = container.querySelector('#food-list');
    if (!listEl) return;
    if (!foods.length) {
      listEl.innerHTML = '<p class="small-text">No foods saved yet.</p>';
      return;
    }
    const rows = foods
      .sort((a, b) => (a.favorite === b.favorite ? a.name.localeCompare(b.name) : a.favorite ? -1 : 1))
      .map(
        (food) => `
        <div class="table-like">
          <div><span class="favorite">${food.favorite ? '★' : ''}</span>${food.name}</div>
          <div>${food.caloriesPerServing} kcal</div>
          <div>${food.carbsPerServing} g carbs</div>
          <div>${food.proteinPerServing} g protein</div>
          <div></div>
          <div class="entry-actions">
            <button class="secondary" data-edit="${food.id}">Edit</button>
            <button class="secondary" data-favorite="${food.id}">${food.favorite ? 'Unfavorite' : 'Favorite'}</button>
            <button class="danger" data-delete="${food.id}">Delete</button>
          </div>
        </div>`
      )
      .join('');
    listEl.innerHTML = `
      <div class="table-like header">
        <div>Name</div><div>Calories</div><div>Carbs</div><div>Protein</div><div></div><div>Actions</div>
      </div>
      ${rows}
    `;

    listEl.querySelectorAll<HTMLButtonElement>('button[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.edit;
        const existing = foods.find((f) => f.id === id);
        if (existing) {
          renderFoodForm({
            container: foodFormContainer,
            food: existing,
            onSave: () => renderFoods(),
          });
        }
      });
    });

    listEl.querySelectorAll<HTMLButtonElement>('button[data-favorite]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.favorite;
        const existing = foods.find((f) => f.id === id);
        if (!existing || !state.user) return;
        const foodRef = doc(db, 'users', state.user.uid, 'foods', existing.id);
        await updateDoc(foodRef, { favorite: !existing.favorite });
        state.foodCache = state.foodCache.map((f) => (f.id === existing.id ? { ...f, favorite: !f.favorite } : f));
        renderFoods();
      });
    });

    listEl.querySelectorAll<HTMLButtonElement>('button[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.delete;
        const existing = foods.find((f) => f.id === id);
        if (!existing || !state.user) return;
        const confirmed = confirm(
          'Delete this food? Historical entries will keep their stored nutrition snapshot.'
        );
        if (!confirmed) return;
        const foodRef = doc(db, 'users', state.user.uid, 'foods', existing.id);
        await deleteDoc(foodRef);
        state.foodCache = state.foodCache.filter((f) => f.id !== existing.id);
        renderFoods();
      });
    });
  };

  container.querySelector('#create-food')?.addEventListener('click', () => {
    renderFoodForm({
      container: foodFormContainer,
      onSave: () => renderFoods(),
    });
  });

  const foods = state.foodCache.length ? state.foodCache : await getUserFoods();
  renderList(foods);
};

const renderEntryForm = async (options: { date: string; entryId?: string }) => {
  const { date, entryId } = options;
  state.entryReturnContext = options;
  const container = buildShell();
  container.innerHTML = `
    <section class="card">
      <div class="flex space-between">
        <div>
          <p class="small-text">${entryId ? 'Edit entry' : 'Add entry'}</p>
          <h2>${date}</h2>
        </div>
        <button id="back-dashboard" class="secondary">Back</button>
      </div>
      <form id="entry-form" class="form-grid"></form>
    </section>
  `;
  container.querySelector('#back-dashboard')?.addEventListener('click', () => renderDashboard());

  if (!state.entryFormFoodCacheLoaded) await getUserFoods();
  const foods = state.foodCache;

  const entryForm = container.querySelector<HTMLFormElement>('#entry-form');
  if (!entryForm) return;

  let selectedFood: Food | undefined;
  let servings = 1;
  let perServing = { calories: 0, carbs: 0, protein: 0 };
  let typedName = '';

  const normalizeServingsInput = (value: string) => {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.floor(parsed);
    }
    return 1;
  };

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
      totalsEl.innerHTML = `
        <div class="total-card">${formatNumber(calories)} kcal</div>
        <div class="total-card">${formatNumber(carbs)} g carbs</div>
        <div class="total-card">${formatNumber(protein)} g protein</div>
      `;
    }
  };

  const renderFoodSuggestions = (term: string) => {
    const suggestionEl = entryForm.querySelector<HTMLDivElement>('#food-suggestions');
    if (!suggestionEl) return;
    const filtered = sortFoodsForPicker(foods, term);
    if (filtered.length === 0 && term.trim()) {
      suggestionEl.innerHTML = `<div class="food-suggestions"><button id="create-food-inline">Create "${term}"</button></div>`;
      suggestionEl.querySelector('#create-food-inline')?.addEventListener('click', () => {
        const inlineContainer = entryForm.querySelector<HTMLDivElement>('#inline-food-form');
        if (!inlineContainer) return;
        renderFoodForm({
          container: inlineContainer,
          prefillName: term,
          onSave: (newFood) => {
            state.foodCache.push(newFood);
            selectedFood = newFood;
            (entryForm.querySelector<HTMLInputElement>('#food') || {}).value = newFood.name;
            perServing = {
              calories: newFood.caloriesPerServing,
              carbs: newFood.carbsPerServing,
              protein: newFood.proteinPerServing,
            };
            renderFoodSuggestions(newFood.name);
            inlineContainer.innerHTML = '';
            updateTotals();
          },
        });
      });
      return;
    }
    suggestionEl.innerHTML = '<div class="food-suggestions"></div>';
    const list = suggestionEl.querySelector('.food-suggestions');
    filtered.forEach((food) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = `${food.favorite ? '<span class="favorite">★</span>' : ''}${food.name}`;
      btn.addEventListener('click', () => {
        selectedFood = food;
        perServing = {
          calories: food.caloriesPerServing,
          carbs: food.carbsPerServing,
          protein: food.proteinPerServing,
        };
        const input = entryForm.querySelector<HTMLInputElement>('#food');
        if (input) input.value = food.name;
        renderFoodSuggestions(food.name);
        updateTotals();
      });
      list?.appendChild(btn);
    });
  };

  entryForm.innerHTML = `
    <div>
      <label for="food">Food</label>
      <input id="food" name="food" autocomplete="off" value="${typedName}" placeholder="Start typing a food" />
      <div id="food-suggestions"></div>
      <div id="inline-food-form"></div>
    </div>
    <div>
      <label for="servings">Servings</label>
      <input
        id="servings"
        name="servings"
        type="text"
        inputmode="numeric"
        pattern="[0-9]*"
        placeholder="e.g., 1"
        value="${servings}"
        required
      />
    </div>
    <div>
      <label for="calories">Calories per serving</label>
      <input id="calories" name="calories" type="number" min="0" value="${perServing.calories}" required />
    </div>
    <div>
      <label for="carbs">Carbs (g) per serving</label>
      <input id="carbs" name="carbs" type="number" min="0" value="${perServing.carbs}" required />
    </div>
    <div>
      <label for="protein">Protein (g) per serving</label>
      <input id="protein" name="protein" type="number" min="0" value="${perServing.protein}" required />
    </div>
    <div id="entry-totals" class="totals"></div>
    <div class="footer-actions">
      ${entryId ? '<button type="button" class="secondary" id="cancel-edit">Cancel</button>' : ''}
      <button type="submit">Save entry</button>
    </div>
  `;

  renderFoodSuggestions(typedName);
  updateTotals();

  entryForm.querySelector<HTMLInputElement>('#food')?.addEventListener('input', (e) => {
    typedName = (e.target as HTMLInputElement).value;
    selectedFood = undefined;
    renderFoodSuggestions(typedName);
  });

  const perServingInputs = ['#calories', '#carbs', '#protein'];
  perServingInputs.forEach((selector) =>
    entryForm.querySelector<HTMLInputElement>(selector)?.addEventListener('input', (e) => {
      const value = Number((e.target as HTMLInputElement).value || 0);
      if (selector === '#calories') perServing.calories = value;
      if (selector === '#carbs') perServing.carbs = value;
      if (selector === '#protein') perServing.protein = value;
      updateTotals();
    })
  );

  const servingsInput = entryForm.querySelector<HTMLInputElement>('#servings');
  const syncServingsInput = () => {
    if (!servingsInput) return;
    servings = normalizeServingsInput(servingsInput.value || '1');
    servingsInput.value = String(servings);
    updateTotals();
  };

  servingsInput?.addEventListener('input', syncServingsInput);
  servingsInput?.addEventListener('blur', syncServingsInput);

  entryForm.querySelector('#cancel-edit')?.addEventListener('click', () => renderDashboard());

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
      servings,
      caloriesPerServing: perServing.calories,
      carbsPerServing: perServing.carbs,
      proteinPerServing: perServing.protein,
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
    renderDashboard();
  });
};

const renderShellAndRoute = () => {
  renderDashboard();
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
    renderDashboard();
  }
  if (target.id === 'nav-foods') {
    renderFoods();
  }
  if (target.id === 'nav-add-entry') {
    renderEntryForm({ date: state.selectedDate });
  }
});
