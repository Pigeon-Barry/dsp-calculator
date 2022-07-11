/*Copyright 2019 Kirk McDonald

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.*/
import {Formatter} from "./align.js"
import {displayItems} from "./display.js"
import {formatSettings} from "./fragment.js"
import {Rational, zero, half, one} from "./rational.js"
import {BuildTarget} from "./target.js"
import {Totals} from "./totals.js"
import {renderTotals} from "./visualize.js"

const DEFAULT_ITEM_KEY = "iron_ingot"

let minerCategories = new Set(["mineral", "oil", "water"])

export let resourcePurities = [
    {key: "0", name: "Impure", factor: half},
    {key: "1", name: "Normal", factor: one},
    {key: "2", name: "Pure", factor: Rational.from_float(2)},
]

export let DEFAULT_PURITY = resourcePurities[1]

export let DEFAULT_BELT = "belt1"
export let DEFAULT_ASSEMBLER = "assembler1"
export let DEFAULT_SMELTER = "smelter1"

class FactorySpecification {
    constructor() {
        // Game data definitions
        this.items = null
        this.recipes = null
        this.buildings = null
        this.belts = null
        this.assemblers = null
        this.smelters = null

        this.itemTiers = []

        this.buildTargets = []

        // Map resource recipe to {miner, purity}
        this.miners = new Map()
        this.minerSettings = new Map()

        // Map recipe to overclock factor
        this.overclock = new Map()

        // Map item to recipe
        this.altRecipes = new Map()

        this.belt = null


        this.assembler = null
        this.smelter = null
        this.ignore = new Set()


        this.format = new Formatter()
    }

    setData(items, recipes, buildings, belts, assemblers,smelters) {
        this.items = items
        let tierMap = new Map()
        for (let [itemKey, item] of items) {
            let tier = tierMap.get(item.tier)
            if (tier === undefined) {
                tier = []
                tierMap.set(item.tier, tier)
            }
            tier.push(item)
        }
        this.itemTiers = []
        for (let [tier, tierItems] of tierMap) {
            this.itemTiers.push(tierItems)
        }
        this.itemTiers.sort((a, b) => a[0].tier - b[0].tier)
        this.recipes = recipes
        this.buildings = new Map()
        for (let building of buildings) {
            let category = this.buildings.get(building.category)
            if (category === undefined) {
                category = []
                this.buildings.set(building.category, category)
            }
            category.push(building)
            if (minerCategories.has(building.category)) {
                this.miners.set(building.key, building)
            }
        }
        this.belts = belts
        this.belt = belts.get(DEFAULT_BELT)
        this.assemblers = assemblers
        this.smelters = smelters
        this.assembler = assemblers.get(DEFAULT_ASSEMBLER)
        this.smelter = smelters.get(DEFAULT_SMELTER)
        this.initMinerSettings()
        // this.initOverclockSettings()
    }

    initMinerSettings() {
        this.minerSettings = new Map()
        for (let [recipeKey, recipe] of this.recipes) {
            if (minerCategories.has(recipe.category)) {
                let miners = this.buildings.get(recipe.category)
                // Default to miner mk1.
                let miner = miners[0]
                // Default to normal purity.
                let purity = DEFAULT_PURITY
                this.minerSettings.set(recipe, {miner, purity})
            }
        }
    }

    getRecipe(item) {
        // TODO: Alternate recipes.
        let recipe = this.altRecipes.get(item)
        if (recipe === undefined) {
            return item.recipes[0]
        } else {
            return recipe
        }
    }

    setRecipe(recipe) {
        let item = recipe.product.item
        if (recipe === item.recipes[0]) {
            this.altRecipes.delete(item)
        } else {
            this.altRecipes.set(item, recipe)
        }
    }


    checkBuilding(category, searchKey, recipe){
        console.log(recipe.category)
        let buildings = this.buildings.get(recipe.category);
        for (let index in buildings) {
            console.log(buildings[index])
            console.log("Search Key: " + searchKey)
            if (buildings[index].key === searchKey) {
                return buildings[index];
            }
        }
        console.log("Not Found")
        return this.buildings.get(recipe.category)[0]
    }

    getBuilding(recipe) {
        if (recipe.category === null) {
            return null
        } else if (this.minerSettings.has(recipe)) {
            return this.minerSettings.get(recipe).miner
        } else if (recipe.category === "crafting") {
            return this.checkBuilding("crafting",this.assembler.key,recipe);
        } else if (recipe.category === "smelting") {
            return this.checkBuilding("smelting",this.smelter.key,recipe);
        } else {
            return this.buildings.get(recipe.category)[0];
        }
    }





    getOverclock(recipe) {
        let oc = this.overclock.get(recipe)
        if (oc) {
            return oc
        } else {
            return one
        }
    }

    setOverclock(recipe, overclock) {
        if (overclock.equal(one)) {
            this.overclock.delete(recipe)
        } else {
            this.overclock.set(recipe, overclock)
        }
    }

    // Returns the recipe-rate at which a single building can produce a recipe.
    // Returns null for recipes that do not have a building.
    getRecipeRate(recipe) {
        let building = this.getBuilding(recipe)
        if (building === null) {
            return null
        }
        return building.getRecipeRate(this, recipe)
    }

    getResourcePurity(recipe) {
        return this.minerSettings.get(recipe).purity
    }

    setMiner(recipe, miner, purity) {
        this.minerSettings.set(recipe, {miner, purity})
    }

    getCount(recipe, rate) {
        let building = this.getBuilding(recipe)
        if (building === null) {
            return zero
        }
        return building.getCount(this, recipe, rate)
    }

    getBeltCount(rate) {
        return rate.div(this.belt.rate)
    }

    getPowerUsage(recipe, rate, itemCount) {
        let building = this.getBuilding(recipe)
        if (building === null || this.ignore.has(recipe)) {
            return {average: zero, peak: zero}
        }
        let count = this.getCount(recipe, rate)
        let average = building.power.mul(count)
        let peak = building.power.mul(count.ceil())
        let overclock = this.overclock.get(recipe)
        if (overclock !== undefined) {
            // The result of this exponent will typically be irrational, so
            // this approximation is a necessity. Because overclock is limited
            // to the range [0.01, 2.50], any imprecision introduced by this
            // approximation is minimal (and is probably less than is present
            // in the game itself).
            let overclockFactor = Rational.from_float(Math.pow(overclock.toFloat(), 1.6))
            average = average.mul(overclockFactor)
            peak = peak.mul(overclockFactor)
        }
        return {average, peak}
    }

    addTarget(itemKey) {
        if (itemKey === undefined) {
            itemKey = DEFAULT_ITEM_KEY
        }
        let item = this.items.get(itemKey)
        let target = new BuildTarget(this.buildTargets.length, itemKey, item, this.itemTiers)
        this.buildTargets.push(target)
        d3.select("#targets").insert(() => target.element, "#plusButton")
        return target
    }

    removeTarget(target) {
        this.buildTargets.splice(target.index, 1)
        for (let i = target.index; i < this.buildTargets.length; i++) {
            this.buildTargets[i].index--
        }
        d3.select(target.element).remove()
    }

    toggleIgnore(recipe) {
        if (this.ignore.has(recipe)) {
            this.ignore.delete(recipe)
        } else {
            this.ignore.add(recipe)
        }
    }

    solve() {
        let totals = new Totals()
        for (let target of this.buildTargets) {
            let subtotals = target.item.produce(this, target.getRate(), this.ignore)
            totals.combine(subtotals)
        }
        return totals
    }

    setHash() {
        window.location.hash = "#" + formatSettings()
    }

    updateSolution() {
        let totals = this.solve()
        displayItems(this, totals, this.ignore)
        renderTotals(totals, this.buildTargets, this.ignore)
        this.setHash()
    }
}

export let spec = new FactorySpecification()
window.spec = spec
