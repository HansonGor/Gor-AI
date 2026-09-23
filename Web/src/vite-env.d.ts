/// <reference types="vite/client" />

// 声明 Less 模块类型
declare module '*.less' {
  const classes: { [key: string]: string };
  export default classes;
}

// 声明图片模块类型
declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.gif' {
  const src: string;
  export default src;
}

declare module '*.webp' {
  const src: string;
  export default src;
}
