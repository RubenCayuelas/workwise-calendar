# Workwise Calendar

Interactive calendar app for tracking and distributing work hours across client projects.

## Project Structure

- **app/** - Next.js App Router pages and layout
- **src/lib/** - Database and utility functions
- **src/types/** - TypeScript type definitions
- **src/components/** - React components
- **public/locales/** - i18n translation files (es, en)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Initialize the database:
   ```bash
   npm run build
   ```

3. Start development server:
   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

## Architecture

- **Frontend**: Next.js 15 with TypeScript and Tailwind CSS
- **Backend**: Built-in Next.js API routes
- **Database**: SQLite with better-sqlite3
- **Internationalization**: i18next with Spanish (es) as default

## Development Notes

- All code comments and internal documentation must be in English
- UI strings must be in i18n translation files (public/locales/)
- Database schema defined in `src/lib/migrations.ts`
- Composition engine logic will be ported from `recompose-poc.js`

## Next Steps

- [ ] Set up API routes for CRUD operations
- [ ] Port recompose-poc.js logic to composition engine
- [ ] Create calendar week view component
- [ ] Implement drag-and-drop functionality
- [ ] Add comprehensive testing
