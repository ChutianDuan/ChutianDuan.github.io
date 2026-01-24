---
title: "allocator动态内存分配"
date: 2026-01-09 09:27:57
tags:
  - "C++"
  - "allocator"
  - "内存管理"
categories:
  - "学习"
  - "现代C++实践"
thumbnail: /img/covers/cover9.jpg
---
# allocator 自定义动态分配
time:2026_1_9
std::allocator 是 C++ 标准库中的一个模板类，主要用于内存的分配和释放。它是 STL 容器（如 std::vector、std::list 等）的默认内存分配器，提供了灵活的内存管理功能。通过 std::allocator，用户可以自定义内存分配策略，从而更高效地管理程序的内存。
## 自定义分配器
```c++
# include <vector>
# include <iostream>
# include <memory>
template <template T>
class Myallocator:public std::allocator<T{
public:
    using std::allocator<T>::allocator;
    T *allocator(std::size_t n){
        return std::allocator<t>::allcator(n);
    }
    void deallocator(T *p, std::size_t n){
        std::allocator<T>::deallocator(p,n);
    }
};
int main(){
    
}
```