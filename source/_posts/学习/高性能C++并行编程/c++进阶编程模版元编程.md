---
title: "c++进阶编程模版元编程"
date: 2025-12-16 10:24:06
tags:
  - "C++"
  - "模板元编程"
categories:
  - "学习"
  - "高性能C++并行编程"
thumbnail: /img/covers/cover5.jpg
---
# C++进阶编程模版元编程
time：2025_12_16
## 模版函数定义
模版函数
```c++
# include<iostream>

template <class T>
T tiwice(T c){
    return c*2;
}
// std::string tiwice(std::string s) 自动重载
// 调用的时候要采用“tiwice(std::sting s)”不能直接使用tiwice(s) 这样会重载到tiwice<char>(s)的从而报错
std::string tiwice(std::string s){
    return s+s
}
int main(){
    std::cout<< tiwice<int>(int 2)<< std::endl;
    /*
    tiwice<int>(int 2) == tiwice(2)
    当模板类型参数 T 作为函数参数时，则可以省略该模板参数。自动根据调用者的参数判断。
    */
    std::cout<< tiwice<float>(float 3.14)<< std::endl;
    return 0;
}
```
模版参数
```c++
# include<iostream>
templace <int N> //不过模板参数只支持整数类型（包括 enum）
void show_times(std::string msg){
    for(int i =0 i<N;i++){
        std::cout<< msg << std::endl;
    }
}
int main(){
    show_time<2>("hello");
    return 0;
}
```

通过模版常量定义编译常量优化代码运行速度
```c++
# include<iostream>
templace <bool debug>
int sumto(int n){
    int res = 0;
    for(int i=1;i<=n;i++){
        res +=i;
        if(debug) std::cout<< res<< std::endl;
    }
    return res;
}
int main(){
    std::cout<< sumto<false>(10)<< std::endl;
    return 0;
}
```

## 自动推导类型（auto）
& 修饰符
const
int const 和 int 两个不同的常量
int && -> int const &

## 函数对象函数式编程
```c++
# include<iostream>
void print_number(int n){
    printf("Number%d",n);
}
void print_float(float n){
    printf("Number%f",n);
}
template <class Func>
void call_twice(Func func){
    func(0);
    func(1);
}
int main(){
    call_twice(print_number)
    call_twice(print_float)
    return 0;
}
```
lambda [](){}
[&] 闭包 可以引用main函数中的变量 读入写入 注意捕获对象的生命周期
[=] 会给每一个引用了的变量做一份拷贝，放在 Func 类型中。

```c++
# include<iostream>
template <class Func>
void call_twice(Func const &func){
    std::cout<< func(0) << std::endl;
    std::cout<< func(2) << std::endl;
}
auto make_tiwce(int fac){
    return [=](int n){
        return n*fac;
    }
}
int main(){
    auto twice = make_tiwce(2) // fac = 2 return n*2;
    call_twice(twice);
    return 0;
}
```
lambda:yield model
``` c++
# include<iostream>
# include<vector>

template <class Func>
void fetch_data(Func connst &func){
    for(int i =0;i<32;i++){
        func(i);
        func(i+0.5f);
    }
}
int main(){
    std::vector<int> res_i;
    std::vector<float> res_f;
    fetch_data([&](auto const &x){
        using T = std::decay_t<decltype(x)>;
        if constexpr(std::is_same_v<T,int>)  res_i.push_back(x);
        else if constexpr(std::is_same_v<T,float>) res_f.push_back(x);
    });
    return 0;
}
```
lambda 局部递归
```c++
# include<iostream>
# include<vector>
# include<set>

int main(){
    std::vector<int> arr ={1,2,34,4234,21};
    std::set<int> visited;
    auto dfs = [&](auto const & dfs, int index){
        if(visited.find(arr[index]) == visited.end()){
            visited.insert(arr[index]);
            int next = arr[index];
            dfs(dfs, next)
        }
    };
    dfs(dfs,0);
    return 0;
}
```
## 容器tuple

## 补充
运行常量和编译常量
