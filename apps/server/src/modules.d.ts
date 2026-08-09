/** Allow importing .sh files as string content (mirrors the edge/ module declaration). */
declare module "*.sh" {
  const content: string;
  export default content;
}
