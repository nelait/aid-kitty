import React from 'react';
import { Link, useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth-context';
import { 
  Bot, 
  Home, 
  PlusCircle, 
  FolderOpen, 
  MessageCircle,
  Settings,
  Calculator,
  User, 
  LogOut,
  Menu,
  X,
  Zap,
  Bell,
  Search,
  HelpCircle
} from 'lucide-react';
import { useState } from 'react';

export default function Navbar() {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const navigation = [
    { name: 'Home', href: '/', icon: Home },
    { name: 'Generate', href: '/generate', icon: PlusCircle },
    { name: 'Projects', href: '/projects', icon: FolderOpen },
    { name: 'Chat', href: '/chat', icon: MessageCircle },
    { name: 'Settings', href: '/settings', icon: Settings },
    { name: 'Estimation', href: '/estimation-settings', icon: Calculator },
    { name: 'Prompt Builder', href: '/prompt-builder', icon: Zap },
  ];

  const isActive = (path: string) => location === path;

  const getUserInitials = (username: string) => {
    return username?.charAt(0).toUpperCase() || 'U';
  };

  return (
    <nav className="bg-white/95 backdrop-blur-lg border-b border-gray-200/50 sticky top-0 z-50 shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/">
            <div className="flex items-center space-x-3 cursor-pointer group">
              <div className="w-9 h-9 bg-gradient-to-br from-blue-500 via-purple-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg group-hover:shadow-xl transition-all duration-300 group-hover:scale-105">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <span className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                AID Kitty
              </span>
            </div>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center space-x-1">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.name} href={item.href}>
                  <div className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer ${
                    isActive(item.href)
                      ? 'text-blue-600 bg-blue-50 shadow-sm border border-blue-100'
                      : 'text-gray-600 hover:text-blue-600 hover:bg-gray-50 hover:shadow-sm'
                  }`}>
                    {Icon && <Icon className="w-4 h-4" />}
                    <span className="hidden lg:block">{item.name}</span>
                  </div>
                </Link>
              );
            })}
          </div>

          {/* User Menu & Shortcuts */}
          <div className="hidden md:flex items-center space-x-3">
            {user ? (
              <>
                {/* Quick Action Shortcuts */}
                <div className="flex items-center space-x-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-9 h-9 p-0 rounded-xl hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                    title="Search"
                  >
                    <Search className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-9 h-9 p-0 rounded-xl hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                    title="Notifications"
                  >
                    <Bell className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-9 h-9 p-0 rounded-xl hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                    title="Help"
                  >
                    <HelpCircle className="w-4 h-4" />
                  </Button>
                </div>

                {/* User Avatar & Menu */}
                <div className="flex items-center space-x-3 pl-3 border-l border-gray-200">
                  <div className="flex items-center space-x-2">
                    <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white text-sm font-semibold shadow-sm">
                      {getUserInitials(user.username)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={logout}
                    className="text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-xl px-3 py-2 transition-all duration-200"
                    title="Logout"
                  >
                    <LogOut className="w-4 h-4" />
                  </Button>
                </div>
              </>
            ) : (
              <div className="flex items-center space-x-3">
                <Link href="/login">
                  <Button variant="ghost" size="sm" className="rounded-xl">
                    Login
                  </Button>
                </Link>
                <Link href="/register">
                  <Button size="sm" className="rounded-xl bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 shadow-sm">
                    Sign Up
                  </Button>
                </Link>
              </div>
            )}
          </div>

          {/* Mobile menu button */}
          <div className="md:hidden flex items-center space-x-2">
            {user && (
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white text-sm font-semibold">
                {getUserInitials(user.username)}
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="w-9 h-9 p-0 rounded-xl"
            >
              {mobileMenuOpen ? (
                <X className="w-5 h-5" />
              ) : (
                <Menu className="w-5 h-5" />
              )}
            </Button>
          </div>
        </div>

        {/* Mobile Navigation */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-gray-200/50 py-4 bg-white/95 backdrop-blur-lg">
            <div className="space-y-1">
              {navigation.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.name} href={item.href}>
                    <div 
                      className={`flex items-center space-x-3 px-4 py-3 rounded-xl text-sm font-medium cursor-pointer mx-2 transition-all duration-200 ${
                        isActive(item.href)
                          ? 'text-blue-600 bg-blue-50 border border-blue-100'
                          : 'text-gray-700 hover:text-blue-600 hover:bg-gray-50'
                      }`}
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      {Icon && <Icon className="w-5 h-5" />}
                      <span>{item.name}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
            
            {/* Mobile Quick Actions */}
            {user && (
              <div className="mt-4 pt-4 border-t border-gray-200/50">
                <div className="flex items-center justify-around px-4 py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex flex-col items-center space-y-1 h-auto py-2 px-3 rounded-xl"
                  >
                    <Search className="w-5 h-5 text-gray-500" />
                    <span className="text-xs text-gray-500">Search</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex flex-col items-center space-y-1 h-auto py-2 px-3 rounded-xl"
                  >
                    <Bell className="w-5 h-5 text-gray-500" />
                    <span className="text-xs text-gray-500">Alerts</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex flex-col items-center space-y-1 h-auto py-2 px-3 rounded-xl"
                  >
                    <HelpCircle className="w-5 h-5 text-gray-500" />
                    <span className="text-xs text-gray-500">Help</span>
                  </Button>
                </div>
              </div>
            )}
            
            <div className="mt-4 pt-4 border-t border-gray-200/50">
              {user ? (
                <div className="space-y-2 px-2">
                  <div className="flex items-center space-x-3 px-4 py-3 text-sm text-gray-700 bg-gray-50 rounded-xl">
                    <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white text-sm font-semibold">
                      {getUserInitials(user.username)}
                    </div>
                    <span className="font-medium">{user.username}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      logout();
                      setMobileMenuOpen(false);
                    }}
                    className="w-full justify-start text-gray-700 hover:text-red-600 hover:bg-red-50 rounded-xl"
                  >
                    <LogOut className="w-4 h-4 mr-3" />
                    Logout
                  </Button>
                </div>
              ) : (
                <div className="space-y-2 px-2">
                  <Link href="/login">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="w-full justify-start rounded-xl"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      Login
                    </Button>
                  </Link>
                  <Link href="/register">
                    <Button 
                      size="sm" 
                      className="w-full rounded-xl bg-gradient-to-r from-blue-500 to-purple-600"
                      onClick={() => setMobileMenuOpen(false)}
                    >
                      Sign Up
                    </Button>
                  </Link>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
