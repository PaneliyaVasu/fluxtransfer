export const subtle = typeof window !== 'undefined' ? window.crypto?.subtle : undefined;
export const getRandomValues = (arr) => typeof window !== 'undefined' ? window.crypto?.getRandomValues(arr) : arr;
export default typeof window !== 'undefined' ? window.crypto : {};
