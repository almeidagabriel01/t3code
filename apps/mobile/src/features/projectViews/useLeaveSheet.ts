import { StackActions, useNavigation } from "@react-navigation/native";

/**
 * Opens a page in place of the project sheet: pushed over a sheet, a page would open under it.
 * Going back from the page returns to the thread.
 */
export function useLeaveSheet() {
  const navigation = useNavigation();
  return (name: keyof ReactNavigation.RootParamList, params?: object) =>
    navigation.dispatch(StackActions.replace(name, params));
}
