// The app's single local database. See lib/store.js for the storage and outbox logic.
import { createStore } from './store.js';

export const store = createStore('kalorit');
export const { db, put, remove, getSetting, setSetting, dumpAll, restoreAll, recentFoods } = store;
export { newId } from './store.js';
