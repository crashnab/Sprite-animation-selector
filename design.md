# UI/UX Style Guide

This project should mimic the modern, sleek aesthetic of HeroUI's dark theme using the following specific parameters:

## Typography
- **Primary Font:** 'Hanken Grotesk', sans-serif. 
- Please import this font from Google Fonts in the CSS: `@import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300;400;500;600;700&display=swap');`
- Use font weights thoughtfully: bold (600/700) for headers and active states, regular (400) for standard UI text.

## Color Palette (Oklch / HSL equivalents based on Hue 230)
- **Background (Base):** Very dark, slightly cool off-black (e.g., `#09090b` or `hsl(230, 10%, 4%)`).
- **Surface/Panels:** Slightly lighter dark grey for the sidebar, timeline, and modal backgrounds (e.g., `#18181b` or `rgba(255, 255, 255, 0.05)`).
- **Primary Accent (Brand):** Vibrant Indigo/Blue (e.g., `#4f46e5` or `hsl(230, 70%, 60%)`). Use this for active buttons, the scrub slider progress, and active frame highlights.
- **Text (Primary):** High-contrast off-white (`#f4f4f5`).
- **Text (Secondary):** Muted grey for non-active elements or timestamps (`#a1a1aa`).
- **Borders:** Extremely subtle, low-opacity white (e.g., `rgba(255, 255, 255, 0.1)`) to separate panels cleanly without heavy lines.

## Component Styling (HeroUI Aesthetic)
- **Border Radius:** Use smooth, medium-rounded corners for buttons, thumbnail containers, and panels (e.g., `border-radius: 12px;`).
- **Transitions:** All interactive elements (buttons, hover states, drag-and-drop targets) must have smooth CSS transitions (e.g., `transition: all 0.2s ease;`).
- **Shadows & Glows:** Use soft drop shadows on floating elements or a subtle indigo box-shadow/glow on the currently active frame in the timeline to make it pop.
- **Scrollbars:** Custom, minimal, dark-themed Webkit scrollbars that blend into the UI so they don't distract from the artwork.
- **Buttons:** Flat with slight hover opacity changes, except for primary calls to action (like the Export buttons) which should use the solid Primary Accent color.
