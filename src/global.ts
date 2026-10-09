/**
 * src/global.ts
 * Side-effect entry point for NativeWind global CSS.
 * Imported once in the root layout.
 */
// @ts-ignore — handled by Metro + NativeWind, not tsc
import '../global.css';

// SafeAreaView de react-native-safe-area-context (el de react-native está
// deprecado). NativeWind necesita saber que su `className` se traduce a `style`.
import { cssInterop } from 'nativewind';
import { SafeAreaView } from 'react-native-safe-area-context';
cssInterop(SafeAreaView, { className: 'style' });
