import { useEffect } from 'react';
import { useLang } from '@rspress/core/runtime';
import {
  Nav as OriginalNav,
  type NavProps,
} from '@rspress/core/theme-original';

export function Nav(props: NavProps) {
  const language = useLang();

  useEffect(() => {
    const main = document.querySelector('main');
    if (!main) return;
    const previousId = main.id;
    main.id = 'as-main-content';
    return () => {
      if (previousId) main.id = previousId;
      else main.removeAttribute('id');
    };
  }, []);

  return (
    <>
      <a className="as-skip-link" href="#as-main-content">
        {language === 'zh' ? '跳到主要内容' : 'Skip to main content'}
      </a>
      <OriginalNav {...props} />
    </>
  );
}
