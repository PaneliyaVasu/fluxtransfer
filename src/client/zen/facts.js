// Flux Zen static facts dataset and provider
(function (window) {
  'use strict';

  const FACTS = [
    // Technology
    { id: 1, category: 'Technology', text: 'The first computer "bug" was an actual moth found trapped in a relay of the Harvard Mark II computer by Grace Hopper in 1947.' },
    { id: 2, category: 'Technology', text: 'The word "robot" comes from the Czech word "robota", which translates to forced labor or drudgery.' },
    { id: 3, category: 'Technology', text: 'The first hard drive, created by IBM in 1956, weighed over a ton and could only store about 5 Megabytes of data.' },
    { id: 4, category: 'Technology', text: 'Domain name registration on the Internet was completely free until 1995.' },
    { id: 5, category: 'Technology', text: 'The first web camera was created at the University of Cambridge to monitor the level of a coffee pot in the computer science department.' },
    { id: 6, category: 'Technology', text: 'The QWERTY keyboard layout was designed to slow down typists to prevent mechanical typewriter bars from jamming.' },
    
    // Space
    { id: 7, category: 'Space', text: 'One day on Venus is longer than one year on Venus. It takes Venus 243 Earth days to rotate once, but only 225 Earth days to orbit the Sun.' },
    { id: 8, category: 'Space', text: 'Space is completely silent because there is no atmosphere (air) to transmit sound waves.' },
    { id: 9, category: 'Space', text: 'Neutron stars are so dense that a single teaspoon of their material would weigh about 6 billion tons on Earth.' },
    { id: 10, category: 'Space', text: 'There are more trees on Earth than stars in the Milky Way. Earth has about 3 trillion trees; our galaxy has 100-400 billion stars.' },
    { id: 11, category: 'Space', text: 'Footprints left on the Moon by Apollo astronauts will stay there for at least 100 million years because there is no wind or water to erode them.' },
    { id: 12, category: 'Space', text: 'Jupiter is twice as massive as all other planets in our solar system combined.' },

    // Geography
    { id: 13, category: 'Geography', text: 'Canada has more lakes than the rest of the world combined, containing roughly 60% of the world\'s lakes.' },
    { id: 14, category: 'Geography', text: 'Russia has a larger surface area than the dwarf planet Pluto.' },
    { id: 15, category: 'Geography', text: 'The driest place on Earth is the Atacama Desert in Chile, where some weather stations have never recorded rain.' },
    { id: 16, category: 'Geography', text: 'There is a town in Norway called "Hell", and it freezes over completely during winter.' },
    { id: 17, category: 'Geography', text: 'Africa is the only continent that spans all four hemispheres (Northern, Southern, Eastern, and Western).' },
    { id: 18, category: 'Geography', text: 'Due to the Earth\'s bulge at the equator, the peak of Mount Chimborazo in Ecuador is the closest point on Earth\'s surface to space.' },

    // Programming
    { id: 19, category: 'Programming', text: 'The first computer programmer was Ada Lovelace, a mathematician who wrote an algorithm for Charles Babbage\'s mechanical computer in 1843.' },
    { id: 20, category: 'Programming', text: 'The Python programming language is not named after the snake, but after the British comedy group Monty Python.' },
    { id: 21, category: 'Programming', text: 'Linus Torvalds created Git in just 2 weeks in 2005 to manage Linux kernel development.' },
    { id: 22, category: 'Programming', text: 'The CSS specification was first proposed by Håkon Wium Lie in 1894 while working at CERN with Tim Berners-Lee.' },
    { id: 23, category: 'Programming', text: 'The ZIP file format was invented by Phil Katz, who released the specification to the public domain in 1989.' },
    { id: 24, category: 'Programming', text: 'The JavaScript language was designed and written in just 10 days in May 1995 by Brendan Eich.' },

    // Science
    { id: 25, category: 'Science', text: 'A single bolt of lightning contains enough electrical energy to toast 100,000 slices of bread.' },
    { id: 26, category: 'Science', text: 'Bananas are slightly radioactive because they contain potassium-40, though eating them is completely safe.' },
    { id: 27, category: 'Science', text: 'Water can boil and freeze at the same time under specific temperature and pressure conditions, known as the "triple point".' },
    { id: 28, category: 'Science', text: 'The human brain operates on about 20 watts of power, which is enough to power a dim LED bulb.' },
    { id: 29, category: 'Science', text: 'Honey never spoils. Archaeologists have found pots of honey in ancient Egyptian tombs that are over 3,000 years old and still edible.' },
    { id: 30, category: 'Science', text: 'Sound travels about 4 times faster in water than it does in air.' }
  ];

  const STORAGE_KEY = 'flux_zen_favorite_facts';

  class FluxZenFactsProvider {
    constructor() {
      this.favorites = this.loadFavorites();
    }

    loadFavorites() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
      } catch (e) {
        console.warn('Failed to load favorites from localStorage', e);
        return [];
      }
    }

    saveFavorites() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.favorites));
      } catch (e) {
        console.warn('Failed to save favorites to localStorage', e);
      }
    }

    getAll() {
      return FACTS;
    }

    getCategories() {
      const cats = new Set(FACTS.map(f => f.category));
      return Array.from(cats);
    }

    getRandom(category = null) {
      const list = category 
        ? FACTS.filter(f => f.category.toLowerCase() === category.toLowerCase())
        : FACTS;
      if (!list.length) return null;
      const idx = Math.floor(Math.random() * list.length);
      return list[idx];
    }

    getNext(currentId, category = null) {
      const list = category 
        ? FACTS.filter(f => f.category.toLowerCase() === category.toLowerCase())
        : FACTS;
      if (!list.length) return null;
      
      const currentIdx = list.findIndex(f => f.id === currentId);
      if (currentIdx === -1) return list[0];
      
      const nextIdx = (currentIdx + 1) % list.length;
      return list[nextIdx];
    }

    toggleFavorite(factId) {
      const idx = this.favorites.indexOf(factId);
      if (idx === -1) {
        this.favorites.push(factId);
      } else {
        this.favorites.splice(idx, 1);
      }
      this.saveFavorites();
      return this.isFavorite(factId);
    }

    isFavorite(factId) {
      return this.favorites.includes(factId);
    }

    getFavoritesCount() {
      return this.favorites.length;
    }
  }

  window.FluxZenFacts = new FluxZenFactsProvider();
})(window);
