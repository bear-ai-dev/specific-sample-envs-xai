import fixture from "../contracts/fixtures/restaurant-arena-v1.json" with { type: "json" };
import { mountRestaurantArenaScene, type RestaurantArenaState } from "./restaurant-arena-scene.js";

const root = document.querySelector<HTMLElement>("#restaurant-arena");
if (!root) throw new Error("Missing #restaurant-arena preview root");

const state = fixture as RestaurantArenaState;
const scene = mountRestaurantArenaScene(root, state);
Object.assign(globalThis, { restaurantArenaPreview: { state, scene } });
