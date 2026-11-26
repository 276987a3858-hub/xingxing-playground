/* =====================================================
   菜谱注册表
   新增菜谱只需在这里注册，厨房引擎按 recipeId 加载
   ===================================================== */

import { omuriceRecipe } from './omurice.js';
import { braisedPorkRecipe } from './braised-pork.js';

const RECIPES = [];
const BY_ID = new Map();

export function registerRecipe(recipe) {
  if (!recipe || typeof recipe.id !== 'string' || !recipe.id) {
    throw new Error('菜谱必须有唯一 id');
  }
  if (BY_ID.has(recipe.id)) {
    throw new Error(`菜谱 id 重复：${recipe.id}`);
  }
  RECIPES.push(recipe);
  BY_ID.set(recipe.id, recipe);
  return recipe;
}

export function getRecipe(id) {
  return BY_ID.get(id) || null;
}

export function listRecipes() {
  return RECIPES.slice();
}

registerRecipe(omuriceRecipe);
registerRecipe(braisedPorkRecipe);