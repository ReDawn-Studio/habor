/** Short greetings should not inherit a previous coding task's tool context. */
export function isCasualGreeting(input: string): boolean {
  const text = input.trim().toLowerCase().replace(/[!！?？。,.，、~～\s]+$/g, "");
  return /^(你好|您好|嗨|哈喽|早上好|晚上好|在吗|hello|hi|hey|yo)$/.test(text);
}
