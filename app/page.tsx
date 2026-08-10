'use client';

import { useEffect, useState } from 'react';

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [language, setLanguage] = useState('es');

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const toggleLanguage = () => {
    setLanguage(language === 'es' ? 'en' : 'es');
  };

  const translations = {
    es: {
      title: 'Calendario Workwise',
      description: 'Gestor de horas y proyectos',
      buttonText: 'Switch to English',
    },
    en: {
      title: 'Workwise Calendar',
      description: 'Work hours and projects manager',
      buttonText: 'Cambiar a Español',
    },
  };

  const t = translations[language as keyof typeof translations];

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">{t.title}</h1>
        <p className="text-xl text-gray-600 mb-8">{t.description}</p>
        <button
          onClick={toggleLanguage}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
        >
          {t.buttonText}
        </button>
      </div>
    </main>
  );
}
